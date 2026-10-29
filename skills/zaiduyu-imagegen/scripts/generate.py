#!/usr/bin/env python3
"""通过 pai.zaiduyu.top 完成多模型生图、图片编辑和账户信息查询。

模型目录和单张积分从站点 /api/config 与 /api/credits 动态读取；
凭据只从环境变量 ZAIDUYU_USER / ZAIDUYU_PASS 读取，不在文件中保存账号信息。
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as _dt
import email.message
import email.utils
import hashlib
import http.client
import ipaddress
import json
import math
import os
import re
import struct
import sys
import threading
import time
import zlib
from dataclasses import dataclass
from typing import Callable, Sequence
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

BASE = "https://pai.zaiduyu.top"
VERSION = "3.2.0"
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_TIMEOUT = 300
DEFAULT_RETRIES = 3
MAX_CONCURRENCY = 3
MAX_IMAGES = 12
MAX_REFERENCE_IMAGES = 16
MAX_REFERENCE_BYTES = 20 * 1024 * 1024
MAX_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024
MAX_RESPONSE_BYTES = 128 * 1024 * 1024
MAX_IMAGE_PIXELS = 100_000_000
MAX_PROMPT_CHARS = 32_000
FRONTEND_VERIFIED_AT = "2026-10-23"
SENSITIVE_HEADERS = frozenset({"cookie", "authorization", "api-key", "x-api-key", "x-goog-api-key"})
ASYNC_FALLBACK_STATUSES = {404, 405, 409, 410, 501}

RATIO_SIZES = {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1280x960",
    "3:4": "960x1280",
    "4:5": "1024x1280",
    "5:4": "1280x1024",
    "16:9": "1536x864",
    "9:16": "864x1536",
}
SUPPORTED_SIZES = set(RATIO_SIZES.values())
# 站点“分辨率档位”是按 ratio 基准尺寸整数倍放大的，见前端 1K/2K/4K 下拉。
RESOLUTION_TIERS = {"1K": 1, "2K": 2, "4K": 4}
TIER_RATIO_SIZES = {
    "1:1": (1024, 1024),
    "3:2": (1008, 672),
    "2:3": (672, 1008),
    "4:3": (1024, 768),
    "3:4": (768, 1024),
    "4:5": (816, 1020),
    "5:4": (1020, 816),
    "16:9": (960, 540),
    "9:16": (540, 960),
}
QUALITY_CHOICES = ("auto", "low", "medium", "high", "standard", "hd")
PARAMETER_IMAGE_MODEL_RE = re.compile(
    r"^(?:gpt-image-2-(?:2k|4k)$|gemini-.*-image(?:-|$))",
    re.IGNORECASE,
)
# 站点对这两个名字用全等判断，带 -4k 后缀的模型走普通 multipart。
PARAMETER_IMAGE_EXACT = frozenset({"gpt-image-2.5-flare", "gpt-image-2.5-sunburst"})
IMAGE_MODEL_ID_RE = re.compile(
    r"(?:gpt-image|imagine-image|(?:^|[-_.])image(?:$|[-_.])|z-image)",
    re.IGNORECASE,
)

CREDENTIAL_HELP = """缺少账号配置：请在自己的终端设置 ZAIDUYU_USER 和 ZAIDUYU_PASS。
不要把密码粘贴到 AI 对话、命令记录或技能文件。配置步骤见 README.md 的凭据小节。
Windows 用户级环境变量为明文存储；配置后重启 WorkBuddy / Codex 以刷新宿主环境。
没有账号可在此注册：https://pai.zaiduyu.top/#/auth?ref=B7F529987DBF
使用邀请码可以额外增加 50 张生图额度。"""


class ApiError(RuntimeError):
    """网站接口返回错误时使用的可读异常。"""

    def __init__(self, message: str, status: int = 0, *, uncertain: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.uncertain = uncertain


class PartialGenerationError(ApiError):
    """Some requests failed; successful images have already been delivered."""

    def __init__(self, message: str, images: list[bytes], failures: list[dict[str, Any]]) -> None:
        super().__init__(message, uncertain=any(item.get("uncertain") for item in failures))
        self.images = images
        self.failures = failures


def _origin(url: str) -> tuple[str, str, int]:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme.lower() != "https" or not parts.hostname or parts.username or parts.password:
        raise ApiError("只允许不含账号信息的 HTTPS 地址")
    try:
        port = parts.port or 443
    except ValueError as exc:
        raise ApiError("地址端口无效") from exc
    return "https", parts.hostname.rstrip(".").lower(), port


def _same_origin(url: str) -> bool:
    return _origin(url) == _origin(BASE)


def _validate_public_url(url: str) -> str:
    if len(url) > 8192 or any(char in url for char in ("\r", "\n", "\\")):
        raise ApiError("图片地址含有不安全字符或过长")
    _origin(url)
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    if host.lower() == "localhost" or host.lower().endswith((".localhost", ".local")):
        raise ApiError("禁止下载本地或内网图片地址")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ApiError("禁止下载本地或内网图片地址")
    return url


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, initial_url: str, *, site_only: bool, no_redirects: bool = False) -> None:
        self.initial_origin = _origin(initial_url)
        self.site_only = site_only
        self.no_redirects = no_redirects

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        target = urllib.parse.urljoin(req.full_url, newurl)
        _validate_public_url(target)
        if self.no_redirects:
            raise ApiError("计算节点不允许重定向", code)
        if self.site_only and not _same_origin(target):
            raise ApiError("已阻止站点凭据请求跳转到外域", code)
        if req.get_method() not in {"GET", "HEAD"}:
            raise ApiError("已阻止有副作用的 POST 请求自动重定向", code, uncertain=True)
        redirected = super().redirect_request(req, fp, code, msg, headers, target)
        if redirected is not None and _origin(target) != _origin(req.full_url):
            for name in list(redirected.headers) + list(redirected.unredirected_hdrs):
                if name.lower() in SENSITIVE_HEADERS or name.lower().startswith("x-qx-"):
                    redirected.remove_header(name)
        return redirected


def read_credentials() -> tuple[str, str]:
    """从环境变量读取账号密码，缺失时给出可操作的中文提示。"""
    user = os.environ.get("ZAIDUYU_USER", "").strip()
    password = os.environ.get("ZAIDUYU_PASS", "").strip()
    if not user or not password:
        raise SystemExit(CREDENTIAL_HELP)
    return user, password


def _request(
    method: str,
    url: str,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> tuple[int, bytes, email.message.Message]:
    request_headers = dict(headers or {})
    _validate_public_url(url)
    site_only = any(name.lower() in SENSITIVE_HEADERS for name in request_headers)
    is_node = any(name.lower() == "x-qx-compute-ticket" for name in request_headers)
    if site_only and not _same_origin(url):
        raise ApiError("禁止向外域发送站点凭据")
    request_headers.setdefault("Accept", "application/json")
    request_headers.setdefault("User-Agent", f"zaiduyu-imagegen/{VERSION}")
    if body is not None:
        request_headers.setdefault("Content-Length", str(len(body)))
    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    opener = urllib.request.build_opener(SafeRedirectHandler(url, site_only=site_only, no_redirects=is_node))
    try:
        with opener.open(request, timeout=timeout) as response:
            data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise ApiError("接口响应超出本地安全大小限制", uncertain=method.upper() == "POST")
            return response.status, data, response.headers
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(1024 * 1024), exc.headers
    except urllib.error.URLError as exc:
        raise ApiError(f"网络请求失败：{type(exc.reason).__name__}", uncertain=method.upper() == "POST") from exc
    except (http.client.HTTPException, TimeoutError, OSError) as exc:
        raise ApiError(f"网络连接中断或超时：{type(exc).__name__}", uncertain=method.upper() == "POST") from exc


def _json_body(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _parse_json(body: bytes, context: str) -> Any:
    text = body.decode("utf-8", "replace")
    try:
        return json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        raise ApiError(f"{context}返回了无效 JSON：{text[:500]}") from exc


def _error_message(body: bytes, fallback: str) -> str:
    text = body.decode("utf-8", "replace")
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return text[:500] or fallback
    if isinstance(obj, dict):
        error = obj.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("msg") or error.get("code")
            if message:
                return str(message)
        for key in ("message", "msg", "detail"):
            if obj.get(key):
                return str(obj[key])
    return text[:500] or fallback


def _retry_after(headers: email.message.Message) -> float:
    value = headers.get("Retry-After", "").strip()
    if not value:
        return 0.0
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            target = email.utils.parsedate_to_datetime(value)
            return max(0.0, target.timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            return 0.0


def _retryable(status: int) -> bool:
    return status in {408, 425, 429, 500, 502, 503, 504} or 500 <= status <= 599


def _request_with_retry(
    method: str,
    url: str,
    body: bytes | None,
    headers: dict[str, str],
    timeout: float,
    retries: int,
    context: str,
) -> tuple[int, bytes, email.message.Message]:
    safe_method = method.upper() in {"GET", "HEAD", "OPTIONS"}
    max_attempts = retries + 1 if safe_method else 1
    for attempt in range(max_attempts):
        try:
            status, response_body, response_headers = _request(method, url, body, headers, timeout)
        except ApiError as exc:
            if not safe_method:
                raise ApiError(
                    f"{context}结果暂时无法确认，未自动重投；请先核对请求状态或积分记录。{exc}",
                    exc.status, uncertain=True,
                ) from exc
            if attempt + 1 >= max_attempts:
                raise
            time.sleep(min(5.0, 2**attempt))
            continue
        if not safe_method or not _retryable(status) or attempt + 1 >= max_attempts:
            return status, response_body, response_headers
        delay = _retry_after(response_headers) or min(5.0, 2**attempt)
        time.sleep(min(delay, 60.0))
    raise ApiError(f"{context}失败")


def _cookie_from_headers(headers: email.message.Message) -> str:
    cookies = headers.get_all("Set-Cookie", [])
    values = [value.split(";", 1)[0].strip() for value in cookies if value]
    return "; ".join(values)


def login(timeout: float) -> str:
    user, password = read_credentials()
    status, body, headers = _request(
        "POST",
        f"{BASE}/api/user-auth",
        _json_body({"action": "login", "identifier": user, "password": password}),
        {"Content-Type": "application/json"},
        timeout,
    )
    cookie = _cookie_from_headers(headers)
    if status != 200 or not cookie:
        raise ApiError(f"登录失败（HTTP {status}）：{_error_message(body, '请检查账号或密码')}", status)
    return cookie


def _authorized_headers(cookie: str, content_type: str | None = None) -> dict[str, str]:
    headers = {"Cookie": cookie}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _checked_response(status: int, body: bytes, context: str) -> Any:
    if status < 200 or status >= 300:
        raise ApiError(f"{context}失败（HTTP {status}）：{_error_message(body, context)}", status)
    return _parse_json(body, context)


def api_json(
    method: str,
    path: str,
    cookie: str,
    payload: Any | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    context: str = "接口请求",
    extra_headers: dict[str, str] | None = None,
) -> Any:
    headers = _authorized_headers(cookie, "application/json" if payload is not None else None)
    headers.update(extra_headers or {})
    status, body, _ = _request_with_retry(
        method,
        f"{BASE}{path}",
        _json_body(payload) if payload is not None else None,
        headers,
        timeout,
        retries,
        context,
    )
    return _checked_response(status, body, context)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _display_number(value: Any) -> str:
    number = _number(value)
    if number is None:
        return "未知"
    return str(int(number)) if number.is_integer() else str(number)


def get_credits(cookie: str, timeout: float, retries: int) -> dict[str, Any]:
    value = api_json("GET", "/api/credits", cookie, timeout=timeout, retries=retries, context="积分查询")
    return value if isinstance(value, dict) else {"data": value}


def credits_overview(value: dict[str, Any]) -> dict[str, Any]:
    overview = value.get("overview")
    return overview if isinstance(overview, dict) else value


def get_site_config(cookie: str, timeout: float, retries: int) -> dict[str, Any]:
    value = api_json("GET", "/api/config", cookie, timeout=timeout, retries=retries, context="站点配置")
    return value if isinstance(value, dict) else {}


def _model_text(item: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("displayName", "introduction", "description"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    return " ".join(parts)


def _is_image_model(model_id: str, item: dict[str, Any], config: dict[str, Any]) -> bool:
    model_types = config.get("modelTypes")
    model_routing = config.get("modelImageRouting")
    image_presets = config.get("modelImagePresets")
    if isinstance(model_types, dict) and model_types.get(model_id) == "image":
        return True
    if isinstance(model_routing, dict) and model_id in model_routing:
        return True
    if isinstance(image_presets, dict) and model_id in image_presets:
        return True
    if IMAGE_MODEL_ID_RE.search(model_id):
        return True
    text = _model_text(item)
    return bool(text and re.search(r"生图|绘图|图片生成|text-to-image|image generation", text, re.IGNORECASE))


def _model_key(value: str) -> str:
    value = value.strip().casefold()
    if "@" in value and value.rsplit("@", 1)[1] in {"openai", "google", "azure", "anthropic"}:
        value = value.rsplit("@", 1)[0].strip()
    return value


def _config_value(config: dict[str, Any], key: str, model_id: str) -> Any:
    mapping = config.get(key)
    if not isinstance(mapping, dict):
        return None
    if model_id in mapping:
        return mapping[model_id]
    return next((v for k, v in mapping.items() if _model_key(str(k)) == _model_key(model_id)), None)


def _custom_image_route(config: dict[str, Any], model_id: str) -> bool:
    value = _config_value(config, "modelImageRouting", model_id)
    return isinstance(value, dict) and value.get("mode") == "custom"


def _route_entry(config: dict[str, Any], model_id: str, operation: str) -> dict[str, Any]:
    model_route = _config_value(config, "modelImageRouting", model_id)
    if not isinstance(model_route, dict):
        return {}
    entry = model_route.get(operation)
    if not isinstance(entry, dict):
        entry = model_route.get("generation")
    return entry if isinstance(entry, dict) else {}


def image_route_kind(config: dict[str, Any], model_id: str, operation: str = "generation") -> str:
    entry = _route_entry(config, model_id, operation)
    protocol = str(entry.get("protocol") or "").lower()
    route_path = str(entry.get("path") or "").lower()
    if "chat" in protocol or "chat/completions" in route_path:
        return "chat"
    if "image" in protocol or "images/" in route_path:
        return "images"
    endpoints = _config_value(config, "modelEndpoints", model_id)
    choices = endpoints if isinstance(endpoints, list) else [endpoints]
    if operation == "edit" and any("images/edits" in str(value).lower() for value in choices):
        return "images"
    if choices and "chat/completions" in str(choices[0] or "").lower():
        return "chat"
    return "images"


def image_routing_header(config: dict[str, Any], model_id: str) -> str | None:
    if _custom_image_route(config, model_id):
        return "1"
    endpoint = _config_value(config, "modelEndpoints", model_id)
    if "chat/completions" in str(endpoint or "").lower() and not _model_key(model_id).startswith(("gpt-", "dall-e")):
        return "1"
    return None


def _image_headers(
    cookie: str,
    model_id: str,
    config: dict[str, Any],
    content_type: str | None = None,
    idempotency_key: str | None = None,
) -> dict[str, str]:
    headers = _authorized_headers(cookie, content_type)
    routing = image_routing_header(config, model_id)
    if routing:
        headers["X-Image-Routing"] = routing
    if idempotency_key:
        # 站点每个图片请求都带唯一幂等键，避免代理或用户重试造成重复扣费。
        headers["Idempotency-Key"] = idempotency_key
    return headers


def openai_image_url(config: dict[str, Any], model_id: str, operation: str) -> str:
    entry = _route_entry(config, model_id, operation)
    # Current site custom routes use the image wrapper for both Chat and Images wire formats.
    if _custom_image_route(config, model_id):
        return f"{BASE}/api/openai/v1/images/{'edits' if operation == 'edit' else 'generations'}"
    path = str(entry.get("path") or "").strip()
    if not path:
        endpoint = _config_value(config, "modelEndpoints", model_id)
        choices = endpoint if isinstance(endpoint, list) else [endpoint]
        if operation == "edit":
            path = next((str(v) for v in choices if "images/edits" in str(v or "")), "")
            if not path and choices and "chat/completions" in str(choices[0] or ""):
                path = str(choices[0])
        elif choices:
            path = str(choices[0] or "").strip()
    path = path or ("images/edits" if operation == "edit" else "images/generations")
    if path.startswith(("http://", "https://")):
        if not _same_origin(path):
            raise ApiError("模型接口配置指向外域，已停止以保护凭据")
        url = path
    else:
        if any(c in path for c in ("\\", "?", "#", "%", " ", "\r", "\n", ":")) or "//" in path:
            raise ApiError("模型接口必须是安全的相对路径")
        parts = path.strip("/").split("/")
        if any(not part or part in {".", ".."} for part in parts):
            raise ApiError("模型接口包含不安全的路径段")
        if path.startswith("/api/"):
            url = f"{BASE}{path}"
        elif path.startswith("api/"):
            url = f"{BASE}/{path}"
        elif path.startswith("v1/"):
            url = f"{BASE}/api/openai/{path}"
        else:
            url = f"{BASE}/api/openai/v1/{path.lstrip('/')}"
    _validate_public_url(url)
    return url


def build_model_catalog(config: dict[str, Any], credits: dict[str, Any]) -> list[dict[str, Any]]:
    pricing = credits.get("pricing")
    raw_models = pricing.get("models") if isinstance(pricing, dict) else None
    if not isinstance(raw_models, list):
        raw_models = []
    known_ids: set[str] = set()
    model_types = config.get("modelTypes")
    if isinstance(model_types, dict):
        known_ids.update(str(k) for k, v in model_types.items() if v == "image")
    for key in ("modelImageRouting", "modelImagePresets"):
        value = config.get(key)
        if isinstance(value, dict):
            known_ids.update(str(k) for k in value)
    catalog: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        model_id = item.get("model")
        if not isinstance(model_id, str) or not model_id.strip():
            continue
        model_id = model_id.strip()
        if model_id in seen or not _is_image_model(model_id, item, config):
            continue
        enabled = item.get("enabled")
        catalog.append({
            "model": model_id,
            "creditsPerRequest": _number(item.get("creditsPerRequest")),
            "enabled": enabled if isinstance(enabled, bool) else None,
            "displayName": str(item.get("displayName") or "").strip(),
            "introduction": str(item.get("introduction") or "").strip(),
            "description": str(item.get("description") or "").strip(),
        })
        seen.add(model_id)
    for model_id in sorted(known_ids):
        if model_id in seen:
            continue
        catalog.append({
            "model": model_id,
            "creditsPerRequest": None,
            "enabled": None,
            "displayName": "",
            "introduction": "",
            "description": "",
        })
    if not catalog:
        raise ApiError("站点配置和积分接口中没有找到可用生图模型")
    return catalog


def _normalized_model_key(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "")).casefold()


def resolve_model(catalog: list[dict[str, Any]], requested: str | None, config: dict[str, Any]) -> dict[str, Any]:
    if not catalog:
        raise ApiError("没有可用生图模型")
    matches: list[dict[str, Any]] = []
    if requested:
        query = requested.strip()
        matches = [item for item in catalog if item["model"] == query]
        if not matches:
            query_key = query.casefold()
            matches = [item for item in catalog if item["model"].casefold() == query_key]
        if not matches:
            query_key = _normalized_model_key(query)
            matches = [
                item for item in catalog
                if item.get("displayName") and _normalized_model_key(item["displayName"]) == query_key
            ]
        if not matches:
            available = ", ".join(item["model"] for item in catalog if item.get("enabled") is not False)
            raise SystemExit(f"未找到模型：{requested}。可用模型：{available}")
        if len(matches) > 1:
            available = ", ".join(item["model"] for item in matches)
            raise SystemExit(f"模型名称不唯一：{requested}，匹配到：{available}")
    else:
        preferred = str(config.get("defaultModel") or "").strip()
        for candidate in (preferred, DEFAULT_MODEL):
            if not candidate:
                continue
            matches = [item for item in catalog if item["model"].casefold() == candidate.casefold()]
            if matches:
                break
        if not matches:
            matches = [item for item in catalog if item.get("enabled") is not False]
        if not matches:
            raise SystemExit("站点当前没有启用的生图模型")
    chosen = matches[0]
    if chosen.get("enabled") is False:
        raise SystemExit(f"模型 {chosen['model']} 当前已停用，请用 --models 查看可用模型。")
    return chosen


def print_model_catalog(catalog: list[dict[str, Any]], credits: dict[str, Any], config: dict[str, Any]) -> None:
    overview = credits_overview(credits)
    print(f"当前总积分：{_display_number(overview.get('balance'))}")
    print(f"永久积分：{_display_number(overview.get('permanentBalance'))}")
    print(f"限时积分：{_display_number(overview.get('limitedBalance'))}")
    print(f"最近到期：{overview.get('nextExpiryAt') or '暂无信息'}")
    print("")
    print("生图模型：")

    def sort_key(item: dict[str, Any]) -> tuple[int, float, str]:
        enabled_rank = 0 if item.get("enabled") is not False else 1
        price = item.get("creditsPerRequest")
        price_rank = float(price) if isinstance(price, (int, float)) else float("inf")
        return enabled_rank, price_rank, item["model"].casefold()

    for item in sorted(catalog, key=sort_key):
        price = item.get("creditsPerRequest")
        price_text = f"{_display_number(price)} 积分/张" if price is not None else "未标价"
        route = image_route_kind(config, item["model"], "generation")
        detail = item.get("displayName") or item.get("introduction") or item.get("description") or ""
        disabled = "，已停用" if item.get("enabled") is False else ""
        suffix = f" | {detail}" if detail else ""
        print(f"- {item['model']} | {price_text} | {route}{disabled}{suffix}")


def print_request_preflight(
    model_info: dict[str, Any],
    n: int,
    credits: dict[str, Any],
    config: dict[str, Any],
    stream: Any = sys.stderr,
    size: str | None = None,
) -> None:
    model_id = model_info["model"]
    price = _number(model_info.get("creditsPerRequest"))
    total = price * n if price is not None else None
    overview = credits_overview(credits)
    balance = _number(overview.get("balance"))
    route = image_route_kind(config, model_id, "generation")
    print(f"模型：{model_id}", file=stream)
    print(f"单张消耗：{_display_number(price) if price is not None else '未标价'}", file=stream)
    print(f"图片数量：{n}", file=stream)
    if size:
        print(f"画面尺寸：{size}", file=stream)
    print(f"预计总消耗：{_display_number(total) if total is not None else '未标价，按站点实际扣费为准'}", file=stream)
    print(f"当前总积分：{_display_number(balance)}", file=stream)
    if total is not None and balance is not None:
        print(f"预计剩余：{_display_number(balance - total)}", file=stream)
    print(f"调用接口：{'Chat' if route == 'chat' else 'Images'}", file=stream)


def check_request_balance(
    model_info: dict[str, Any],
    n: int,
    credits: dict[str, Any],
    warn_balance: float,
    strict: bool,
) -> None:
    overview = credits_overview(credits)
    balance = _number(overview.get("balance"))
    price = _number(model_info.get("creditsPerRequest"))
    total = price * n if price is not None else None
    if balance is not None and balance <= warn_balance:
        print(f"提示：当前总积分为 {_display_number(balance)}，已低于提醒阈值。", file=sys.stderr)
    if balance is not None and total is not None and balance < total:
        print(
            f"提示：预计需要 {_display_number(total)} 积分，当前只有 {_display_number(balance)}。",
            file=sys.stderr,
        )
    if strict:
        if total is None:
            raise SystemExit("该模型未标价，无法使用 --strict-balance 精确校验，已停止提交。")
        if balance is None:
            raise SystemExit("无法读取当前积分，已根据 --strict-balance 停止提交。")
        if balance < total:
            raise SystemExit(
                f"当前总积分不足：预计需要 {_display_number(total)}，当前只有 {_display_number(balance)}。"
            )


def print_balance(value: dict[str, Any]) -> None:
    overview = credits_overview(value)
    print(f"总积分：{_display_number(overview.get('balance'))}")
    print(f"永久积分：{_display_number(overview.get('permanentBalance'))}")
    print(f"限时积分：{_display_number(overview.get('limitedBalance'))}")
    print(f"最近到期：{overview.get('nextExpiryAt') or '暂无信息'}")


def print_history(value: dict[str, Any], limit: int) -> None:
    keys = ("transactions", "creditTransactions", "usageRecords", "modelUsage", "modelUsages", "usage", "records", "history")
    result: dict[str, Any] = {}
    for source in (value, credits_overview(value)):
        for key in keys:
            records = source.get(key)
            if isinstance(records, list) and key not in result:
                result[key] = records[:limit]
    if "nextCursor" in value:
        result["nextCursor"] = value["nextCursor"]
    if not result:
        result = {"transactions": [], "message": "没有返回流水数组；未输出包含定价和账户信息的全量响应。"}
    print(json.dumps(result, ensure_ascii=False, indent=2))


def get_history(cookie: str, timeout: float, retries: int, history_filter: str = "all", before: int | None = None) -> dict[str, Any]:
    query: dict[str, Any] = {"scope": "transactions", "filter": history_filter}
    if before is not None:
        query["before"] = before
    value = api_json("GET", "/api/credits?" + urllib.parse.urlencode(query), cookie, timeout=timeout, retries=retries, context="积分流水")
    return value if isinstance(value, dict) else {"transactions": []}


def get_checkin_status(cookie: str, timeout: float, retries: int, month: str | None = None) -> dict[str, Any]:
    if month:
        if not re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", month):
            raise ApiError("月份必须为 YYYY-MM")
        _dt.date.fromisoformat(month + "-01")
    path = "/api/checkin" + ("?month=" + month if month else "")
    result = api_json("GET", path, cookie, timeout=timeout, retries=retries, context="签到状态")
    return result if isinstance(result, dict) else {}


def checkin(cookie: str, timeout: float, retries: int) -> None:
    status = get_checkin_status(cookie, timeout, retries)
    if status.get("checkedIn") is True:
        print(json.dumps({"checkedIn": True, "message": "今日已签到，未重复提交。", "reward": status.get("reward"), "validityDays": status.get("validityDays")}, ensure_ascii=False, indent=2))
        return
    if status.get("enabled") is False:
        raise ApiError("站点尚未启用签到")
    result = api_json("POST", "/api/checkin", cookie, timeout=timeout, retries=0, context="签到")
    print(json.dumps(result, ensure_ascii=False, indent=2))


def makeup_checkin(cookie: str, timeout: float, retries: int, date: str) -> None:
    day = _dt.date.fromisoformat(date)
    today = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8))).date()
    if day >= today:
        raise ApiError("补签日期必须早于今天")
    status = get_checkin_status(cookie, timeout, retries, day.strftime("%Y-%m"))
    if not status.get("makeupEnabled") or not (_number(status.get("makeupChances")) or 0) > 0:
        raise ApiError("补签未启用或机会不足")
    if any(item.get("date") == date for item in status.get("monthCheckins", []) if isinstance(item, dict)):
        raise ApiError("该日期已签到，未消耗补签机会")
    result = api_json("POST", "/api/checkin", cookie, {"action": "makeup", "date": date}, timeout, retries=0, context="补签")
    print(json.dumps(result, ensure_ascii=False, indent=2))


def resolve_size(ratio: str | None, size: str | None, resolution: str | None = None) -> str:
    if ratio and size:
        raise SystemExit("--ratio 和 --size 不能同时使用，请只指定一个。")
    if size and resolution:
        raise SystemExit("--size 和 --resolution 不能同时使用，请只指定一个。")
    if resolution:
        if resolution not in RESOLUTION_TIERS:
            raise SystemExit(f"不支持的分辨率档位：{resolution}。可用档位：{', '.join(RESOLUTION_TIERS)}")
        base_width, base_height = TIER_RATIO_SIZES[ratio or "1:1"]
        scale = RESOLUTION_TIERS[resolution]
        width, height = base_width * scale, base_height * scale
        if width * height > MAX_IMAGE_PIXELS:
            raise SystemExit(f"{resolution} 档位像素超出本地安全限制，请改用更小的比例。")
        return f"{width}x{height}"
    if ratio:
        return RATIO_SIZES[ratio]
    if size:
        if size in SUPPORTED_SIZES:
            return size
        match = re.fullmatch(r"([1-9]\d{1,4})x([1-9]\d{1,4})", size.strip().lower())
        if match:
            width, height = int(match.group(1)), int(match.group(2))
            if not (64 <= width <= 8192 and 64 <= height <= 8192) or width * height > MAX_IMAGE_PIXELS:
                raise SystemExit("--size 像素超出允许范围：边长 64-8192，总像素不超过 1 亿。")
            return f"{width}x{height}"
        supported = ", ".join(sorted(SUPPORTED_SIZES))
        raise SystemExit(f"不支持的尺寸：{size}。可用尺寸：{supported}，或使用 宽x高 形式（例如 2048x2048）。")
    return RATIO_SIZES["1:1"]


def _base64_bytes(value: str) -> bytes:
    text = re.sub(r"\s+", "", value)
    if not text:
        raise ApiError("图片 base64 数据为空")
    padded = text + "=" * (-len(text) % 4)
    try:
        return base64.b64decode(padded, altchars=b"-_", validate=False)
    except (ValueError, base64.binascii.Error) as exc:
        raise ApiError("图片 base64 数据无效") from exc


def _data_url_bytes(value: str) -> bytes:
    header, separator, payload = value.partition(",")
    if not separator or not header.lower().startswith("data:image/"):
        raise ApiError("图片 data URL 格式无效")
    if ";base64" in header.lower():
        return _base64_bytes(payload)
    return urllib.parse.unquote_to_bytes(payload)


def _image_url_bytes(url: str, cookie: str, timeout: float) -> bytes:
    candidate = url.strip().strip('"\'')
    if candidate.startswith("//"):
        candidate = f"https:{candidate}"
    elif candidate.startswith("/"):
        candidate = urllib.parse.urljoin(f"{BASE}/", candidate)
    if candidate.startswith("data:image/"):
        return _data_url_bytes(candidate)
    if not candidate.startswith(("http://", "https://")):
        raise ApiError(f"不支持的图片地址：{candidate[:120]}")
    _validate_public_url(candidate)
    headers = {"Accept": "image/avif,image/webp,image/png,image/jpeg,image/*", "User-Agent": f"zaiduyu-imagegen/{VERSION}"}
    if _same_origin(candidate):
        headers["Cookie"] = cookie
    status, data, _ = _request_with_retry("GET", candidate, None, headers, timeout, DEFAULT_RETRIES, "图片下载")
    if status != 200:
        raise ApiError(f"图片下载失败（HTTP {status}）", status)
    validate_image(data)
    return data


B64_KEYS = {"b64", "b64_json", "base64", "image_base64", "imagedata", "image_data"}
URL_KEYS = {"url", "image_url", "imageurl", "source_url", "sourceurl"}


def _add_image_bytes(data: bytes | None, found: list[bytes], seen_hashes: set[str]) -> None:
    if not data:
        return
    validate_image(data)
    digest = hashlib.sha256(data).hexdigest()
    if digest in seen_hashes:
        return
    seen_hashes.add(digest)
    found.append(data)


def _add_image_url(
    url: str,
    cookie: str,
    timeout: float,
    found: list[bytes],
    seen_hashes: set[str],
    seen_urls: set[str],
    errors: list[str],
) -> None:
    candidate = url.strip()
    if not candidate or candidate in seen_urls:
        return
    seen_urls.add(candidate)
    try:
        _add_image_bytes(_image_url_bytes(candidate, cookie, timeout), found, seen_hashes)
    except (ApiError, urllib.error.URLError, TimeoutError, OSError) as exc:
        errors.append(str(exc))


DATA_IMAGE_RE = re.compile(
    r"data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n\t ]+",
    re.IGNORECASE,
)
MARKDOWN_IMAGE_RE = re.compile(
    r"!\[[^\]]*\]\((?:<)?(data:image/[^)]+|https?://[^)]+)(?:>)?\)",
    re.IGNORECASE,
)
HTML_IMAGE_RE = re.compile(
    r"<img\b[^>]*\bsrc=[\"'](data:image/[^\"']+|https?://[^\"']+)[\"']",
    re.IGNORECASE,
)


def _looks_like_image_url(value: str) -> bool:
    path = urllib.parse.urlparse(value).path.lower()
    return bool(re.search(r"\.(?:png|jpe?g|webp|gif|bmp|avif)$", path)) or "image" in value.lower()


def _scan_image_text(
    value: str,
    cookie: str,
    timeout: float,
    found: list[bytes],
    seen_hashes: set[str],
    seen_urls: set[str],
    errors: list[str],
) -> None:
    urls: list[str] = []
    for pattern in (MARKDOWN_IMAGE_RE, HTML_IMAGE_RE):
        urls.extend(match.group(1) for match in pattern.finditer(value))
    urls.extend(match.group(0) for match in DATA_IMAGE_RE.finditer(value))
    stripped = value.strip()
    if stripped.startswith(("http://", "https://")) and _looks_like_image_url(stripped):
        urls.append(stripped)
    for url in urls:
        _add_image_url(url, cookie, timeout, found, seen_hashes, seen_urls, errors)


def _scan_image_value(
    value: Any,
    key_hint: str,
    cookie: str,
    timeout: float,
    found: list[bytes],
    seen_hashes: set[str],
    seen_urls: set[str],
    errors: list[str],
) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            key_text = str(key).lower()
            if key_text in B64_KEYS and isinstance(item, str):
                try:
                    _add_image_bytes(_base64_bytes(item), found, seen_hashes)
                except ApiError as exc:
                    errors.append(str(exc))
                continue
            if key_text in URL_KEYS:
                if isinstance(item, str):
                    _add_image_url(item, cookie, timeout, found, seen_hashes, seen_urls, errors)
                elif isinstance(item, dict):
                    nested_url = item.get("url")
                    if isinstance(nested_url, str):
                        _add_image_url(nested_url, cookie, timeout, found, seen_hashes, seen_urls, errors)
            _scan_image_value(item, key_text, cookie, timeout, found, seen_hashes, seen_urls, errors)
        return
    if isinstance(value, list):
        for item in value:
            _scan_image_value(item, key_hint, cookie, timeout, found, seen_hashes, seen_urls, errors)
        return
    if not isinstance(value, str) or not value.strip():
        return
    stripped = value.strip()
    if stripped.startswith(("{", "[")):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = None
        if parsed is not None and parsed != value:
            _scan_image_value(parsed, key_hint, cookie, timeout, found, seen_hashes, seen_urls, errors)
            return
    _scan_image_text(stripped, cookie, timeout, found, seen_hashes, seen_urls, errors)


def extract_images(value: Any, cookie: str, timeout: float) -> list[bytes]:
    found: list[bytes] = []
    seen_hashes: set[str] = set()
    seen_urls: set[str] = set()
    errors: list[str] = []
    _scan_image_value(value, "", cookie, timeout, found, seen_hashes, seen_urls, errors)
    if not found:
        detail = f"；最后错误：{errors[-1]}" if errors else ""
        raise ApiError(f"接口没有返回可识别的图片数据{detail}")
    return found


def generation_payload(
    prompt: str,
    n: int,
    size: str,
    model_id: str,
    config: dict[str, Any],
    size_hint: str | None = None,
    quality: str | None = None,
) -> dict[str, Any]:
    if image_route_kind(config, model_id, "generation") == "chat":
        text = prompt
        if size_hint:
            text = f"{text}\n\n画面尺寸或比例要求：{size_hint}。"
        return {
            "model": model_id,
            "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
            "stream": False,
        }
    payload = {
        "model": model_id,
        "prompt": prompt,
        "n": n,
        "size": size,
        "response_format": "b64_json",
    }
    if quality:
        payload["quality"] = quality
    return payload


def batch_sizes(count: int, limit: int = MAX_CONCURRENCY) -> list[int]:
    # 网站最多允许 3 个任务同时进行，超出的张数只能分批提交
    count = max(1, count)
    sizes = [limit] * (count // limit)
    if count % limit:
        sizes.append(count % limit)
    return sizes


def _log_batch(index: int, total: int, size: int) -> None:
    if total > 1:
        print(f"第 {index}/{total} 批，本批 {size} 张……", file=sys.stderr)


def _direct_generate_batch(
    cookie: str,
    payload: dict[str, Any],
    timeout: float,
    retries: int,
    config: dict[str, Any],
) -> list[bytes]:
    model_id = str(payload["model"])
    url = openai_image_url(config, model_id, "generation")
    status, body, _ = _request_with_retry(
        "POST", url, _json_body(payload),
        _image_headers(cookie, model_id, config, "application/json", f"image-{uuid.uuid4()}"),
        timeout, retries, "图片生成"
    )
    return extract_images(_checked_response(status, body, "图片生成"), cookie, timeout)


def direct_generate(
    cookie: str,
    payload: dict[str, Any],
    n: int,
    timeout: float,
    retries: int,
    config: dict[str, Any],
) -> list[bytes]:
    model_id = str(payload["model"])
    route = image_route_kind(config, model_id, "generation")
    batches = batch_sizes(n)
    images: list[bytes] = []
    for index, size in enumerate(batches, start=1):
        _log_batch(index, len(batches), size)
        if route == "chat":
            with concurrent.futures.ThreadPoolExecutor(max_workers=size) as executor:
                tasks = [
                    executor.submit(_direct_generate_batch, cookie, payload, timeout, retries, config)
                    for _ in range(size)
                ]
                for task in tasks:
                    images.extend(task.result())
        else:
            images.extend(
                _direct_generate_batch(cookie, {**payload, "n": size}, timeout, retries, config)
            )
    return images


def _job_id(value: Any) -> str:
    if isinstance(value, dict) and isinstance(value.get("jobId"), str) and value["jobId"].strip():
        return value["jobId"].strip()
    raise ApiError("异步任务创建成功，但没有返回 jobId")


def async_generate_one(cookie: str, payload: dict[str, Any], timeout: float, retries: int) -> list[bytes]:
    idempotency_key = f"image-{uuid.uuid4()}"
    value = api_json(
        "POST", "/api/image-jobs", cookie,
        {"request": payload, "idempotencyKey": idempotency_key}, timeout, retries,
        "异步图片任务创建", {"Idempotency-Key": idempotency_key}
    )
    job_id = _job_id(value)
    deadline = time.monotonic() + timeout
    delay = 1.0
    while time.monotonic() < deadline:
        remaining = max(1.0, min(30.0, deadline - time.monotonic()))
        try:
            current = api_json(
                "GET", f"/api/image-jobs?jobId={urllib.parse.quote(job_id, safe='')}", cookie,
                timeout=remaining, retries=retries, context="异步图片任务查询"
            )
        except ApiError:
            time.sleep(min(delay, max(0.0, deadline - time.monotonic())))
            delay = min(delay * 2, 5.0)
            continue
        status = current.get("status") if isinstance(current, dict) else None
        if status in {"pending", "running"}:
            time.sleep(min(delay, max(0.0, deadline - time.monotonic())))
            delay = min(delay * 2, 5.0)
            continue
        if status == "failed":
            message = current.get("error") if isinstance(current, dict) else None
            raise ApiError(f"异步图片任务失败：{message or '未知错误'}")
        if status == "completed":
            result = current.get("result") if isinstance(current, dict) else current
            return extract_images(result, cookie, timeout)
        raise ApiError(f"异步图片任务返回未知状态：{status}")
    raise ApiError(f"异步图片任务超过 {int(timeout)} 秒仍未完成，可稍后到网站任务页查看。")


def async_generate(
    cookie: str,
    payload: dict[str, Any],
    n: int,
    timeout: float,
    retries: int,
    config: dict[str, Any],
) -> list[bytes]:
    # 异步任务接口目前只按 Images payload 工作；Chat 模型直接走同步链。
    if image_route_kind(config, str(payload["model"]), "generation") == "chat":
        return direct_generate(cookie, payload, n, timeout, retries, config)
    single_payload = {**payload, "n": 1}
    batches = batch_sizes(n)
    images: list[bytes] = []
    for index, size in enumerate(batches, start=1):
        _log_batch(index, len(batches), size)
        if size == 1:
            images.extend(async_generate_one(cookie, single_payload, timeout, retries))
            continue
        with concurrent.futures.ThreadPoolExecutor(max_workers=size) as executor:
            tasks = [
                executor.submit(async_generate_one, cookie, single_payload, timeout, retries)
                for _ in range(size)
            ]
            for task in tasks:
                images.extend(task.result())
    return images


@dataclass(frozen=True)
class ReferenceImage:
    """本地参考图；data 为原始字节，mime 按真实文件头判定。"""

    name: str
    data: bytes
    mime: str


def load_reference_images(paths: Sequence[str]) -> list[ReferenceImage]:
    if not paths:
        return []
    if len(paths) > MAX_REFERENCE_IMAGES:
        raise SystemExit(f"参考图最多 {MAX_REFERENCE_IMAGES} 张，当前传入 {len(paths)} 张。")
    references: list[ReferenceImage] = []
    seen: dict[str, str] = {}
    total = 0
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if not path.is_file():
            raise SystemExit(f"参考图不存在：{path}")
        size = path.stat().st_size
        if size <= 0:
            raise SystemExit(f"参考图为空文件：{path}")
        if size > MAX_REFERENCE_BYTES:
            raise SystemExit(f"参考图超过 {MAX_REFERENCE_BYTES // (1024 * 1024)} MiB：{path}")
        total += size
        if total > MAX_REFERENCE_TOTAL_BYTES:
            raise SystemExit(
                f"参考图合计超过 {MAX_REFERENCE_TOTAL_BYTES // (1024 * 1024)} MiB，请先压缩或减少张数。"
            )
        data = path.read_bytes()
        try:
            mime = validate_image(data).mime
        except ApiError as exc:
            raise SystemExit(f"参考图不是可识别的图片（{exc}）：{path}") from exc
        digest = hashlib.sha256(data).hexdigest()
        if digest in seen:
            print(f"提示：{path} 与 {seen[digest]} 内容相同，已跳过重复参考图。", file=sys.stderr)
            continue
        seen[digest] = str(path)
        references.append(ReferenceImage(path.name, data, mime))
    if not references:
        raise SystemExit("参考图去重后为空，请检查输入文件。")
    return references


def uses_images_json(config: dict[str, Any], model_id: str) -> bool:
    """站点把多图编辑统一成 JSON images 数组的两类模型。"""
    if _custom_image_route(config, model_id):
        return True
    key = _model_key(model_id)
    if key in PARAMETER_IMAGE_EXACT:
        return True
    return bool(PARAMETER_IMAGE_MODEL_RE.match(key))


def _input_fidelity(model_id: str, count: int) -> str | None:
    key = _model_key(model_id)
    if key.startswith("gpt-image-") and key != "gpt-image-2" and count >= 2:
        return "high"
    return None


def multi_reference_prompt(prompt: str, count: int) -> str:
    """多图时补一段角色说明；单图保持用户原话不变。"""
    if count <= 1:
        return prompt
    head = [
        f"[多图参考] 共 {count} 张参考图：图 1 是待编辑主图，图 2 至图 {count} 是素材参考图。",
        "素材参考图只提供明确指定的人物或物品素材；不要复制其背景、文字或构图，不要混合不同参考图的身份。",
        "主图的尺寸、构图以及未指定修改的区域优先于所有素材参考图。",
        "",
    ]
    return ("\n".join(head) + prompt)[:MAX_PROMPT_CHARS]


def _multipart(fields: dict[str, str], files: Sequence[tuple[str, ReferenceImage]]) -> tuple[bytes, str]:
    boundary = f"----zaiduyu-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode("utf-8"), b"\r\n",
        ])
    for field, reference in files:
        filename = re.sub(r'["\r\n\\/]', "_", reference.name) or "reference"
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode(),
            f"Content-Type: {reference.mime}\r\n\r\n".encode(),
            reference.data, b"\r\n",
        ])
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _data_url(reference: ReferenceImage) -> str:
    return f"data:{reference.mime};base64,{base64.b64encode(reference.data).decode('ascii')}"


def _chat_edit_payload(references: Sequence[ReferenceImage], prompt: str, model_id: str) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for reference in references:
        content.append({"type": "image_url", "image_url": {"url": _data_url(reference)}})
    return {
        "model": model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
    }


def _images_edit_payload(
    references: Sequence[ReferenceImage],
    prompt: str,
    size: str,
    model_id: str,
    quality: str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model_id,
        "prompt": prompt,
        "n": 1,
        "response_format": "b64_json",
    }
    if size and size != "auto":
        payload["size"] = size
    if quality:
        payload["quality"] = quality
    fidelity = _input_fidelity(model_id, len(references))
    if fidelity:
        payload["input_fidelity"] = fidelity
    payload["images"] = [{"image_url": _data_url(reference)} for reference in references]
    return payload


def _edit_request_once(
    cookie: str,
    references: Sequence[ReferenceImage],
    prompt: str,
    size: str,
    model_id: str,
    timeout: float,
    retries: int,
    config: dict[str, Any],
    quality: str | None = None,
) -> list[bytes]:
    text = multi_reference_prompt(prompt, len(references))
    headers_content_type: str
    if uses_images_json(config, model_id):
        body = _json_body(_images_edit_payload(references, text, size, model_id, quality))
        headers_content_type = "application/json"
    elif image_route_kind(config, model_id, "edit") == "chat":
        body = _json_body(_chat_edit_payload(references, text, model_id))
        headers_content_type = "application/json"
    else:
        fields = {
            "model": model_id,
            "prompt": text,
            "n": "1",
            "size": size,
            "response_format": "b64_json",
        }
        fidelity = _input_fidelity(model_id, len(references))
        if quality:
            fields["quality"] = quality
        if fidelity:
            fields["input_fidelity"] = fidelity
        # 站点单图用 image，多图用 image[]，重复同名文件字段。
        field = "image" if len(references) == 1 else "image[]"
        body, headers_content_type = _multipart(fields, [(field, reference) for reference in references])
    url = openai_image_url(config, model_id, "edit")
    status, response_body, _ = _request_with_retry(
        "POST", url, body,
        _image_headers(cookie, model_id, config, headers_content_type, f"image-{uuid.uuid4()}"),
        timeout, retries, "图片编辑"
    )
    return extract_images(_checked_response(status, response_body, "图片编辑"), cookie, timeout)


def _edit_image_batch(
    cookie: str,
    references: Sequence[ReferenceImage],
    prompt: str,
    n: int,
    size: str,
    model_id: str,
    timeout: float,
    retries: int,
    config: dict[str, Any],
    quality: str | None = None,
) -> list[bytes]:
    # 站点编辑固定 n=1 并并发发起多次请求，这里保持一致，避免上游忽略 n 导致张数不符。
    images: list[bytes] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as executor:
        tasks = [
            executor.submit(
                _edit_request_once, cookie, references, prompt, size, model_id,
                timeout, retries, config, quality
            )
            for _ in range(n)
        ]
        for task in tasks:
            images.extend(task.result())
    return images


def edit_image(
    cookie: str,
    references: Sequence[ReferenceImage],
    prompt: str,
    n: int,
    size: str,
    model_id: str,
    timeout: float,
    retries: int,
    config: dict[str, Any],
    quality: str | None = None,
) -> list[bytes]:
    batches = batch_sizes(n)
    images: list[bytes] = []
    for index, batch in enumerate(batches, start=1):
        _log_batch(index, len(batches), batch)
        images.extend(
            _edit_image_batch(
                cookie, references, prompt, batch, size, model_id, timeout, retries, config, quality
            )
        )
    return images


def _safe_description(value: str) -> str:
    cleaned = re.sub(r"[<>:/\\|?*\"\r\n]+", "", value).strip()
    cleaned = re.sub(r"\s+", "", cleaned)
    return (cleaned or "生成图片")[:10]


@dataclass(frozen=True)
class ImageInfo:
    suffix: str
    mime: str
    width: int
    height: int


def _bmff_boxes(data: bytes, start: int = 0, end: int | None = None, depth: int = 0) -> list[tuple[bytes, bytes]]:
    end = len(data) if end is None else end
    if depth > 8:
        raise ApiError("AVIF 图片容器嵌套过深")
    result: list[tuple[bytes, bytes]] = []
    count = 0
    while start < end:
        count += 1
        if count > 10000 or end - start < 8:
            raise ApiError("AVIF 图片容器不完整")
        size = int.from_bytes(data[start:start + 4], "big")
        kind = data[start + 4:start + 8]
        header = 8
        if size == 1:
            if end - start < 16:
                raise ApiError("AVIF 图片容器不完整")
            size = int.from_bytes(data[start + 8:start + 16], "big")
            header = 16
        elif size == 0:
            size = end - start
        if size < header or start + size > end:
            raise ApiError("AVIF 图片容器长度无效")
        payload_start = start + header
        result.append((kind, data[payload_start:start + size]))
        if kind in {b"meta", b"iprp", b"ipco"}:
            nested_start = payload_start + (4 if kind == b"meta" else 0)
            result.extend(_bmff_boxes(data, nested_start, start + size, depth + 1))
        start += size
    return result


def validate_image(data: bytes) -> ImageInfo:
    """Validate container structure and dimensions; not a full JPEG/AV1 pixel decoder."""
    if not data or len(data) > MAX_RESPONSE_BYTES:
        raise ApiError("图片为空或超出本地安全大小限制")
    width = height = 0
    suffix = mime = ""
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            offset, has_header, has_pixels, has_end = 8, False, False, False
            while offset + 12 <= len(data):
                size = int.from_bytes(data[offset:offset + 4], "big")
                kind = data[offset + 4:offset + 8]
                end = offset + size + 12
                if end > len(data):
                    raise ApiError("PNG 图片被截断")
                payload = data[offset + 8:offset + 8 + size]
                crc = int.from_bytes(data[end - 4:end], "big")
                if zlib.crc32(kind + payload) & 0xffffffff != crc:
                    raise ApiError("PNG 校验和无效")
                if not has_header:
                    if kind != b"IHDR" or size != 13:
                        raise ApiError("PNG 缺少有效 IHDR")
                    width, height = struct.unpack(">II", payload[:8])
                    has_header = True
                if kind == b"IDAT":
                    has_pixels = has_pixels or size > 0
                if kind == b"IEND":
                    if size != 0:
                        raise ApiError("PNG 结束块无效")
                    has_end = True
                    break
                offset = end
            if not (has_header and has_pixels and has_end):
                raise ApiError("PNG 图片结构不完整")
            suffix, mime = ".png", "image/png"
        elif data.startswith(b"\xff\xd8\xff"):
            if not data.rstrip(b"\x00\r\n ").endswith(b"\xff\xd9"):
                raise ApiError("JPEG 缺少结束标记，可能已截断")
            offset = 2
            while offset < len(data) - 1:
                if data[offset] != 0xff:
                    offset += 1
                    continue
                while offset < len(data) and data[offset] == 0xff:
                    offset += 1
                if offset >= len(data):
                    break
                marker = data[offset]
                offset += 1
                if marker in {0x00, 0x01, 0xd8, 0xd9} or 0xd0 <= marker <= 0xd7:
                    continue
                length = int.from_bytes(data[offset:offset + 2], "big")
                if length < 2 or offset + length > len(data):
                    raise ApiError("JPEG 图片段长度无效")
                if marker in {0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf}:
                    if length < 8:
                        raise ApiError("JPEG 尺寸段无效")
                    height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
                if marker == 0xda:
                    break
                offset += length
            suffix, mime = ".jpg", "image/jpeg"
        elif data[:6] in {b"GIF87a", b"GIF89a"}:
            if len(data) < 14 or data[-1:] != b";":
                raise ApiError("GIF 图片不完整")
            width, height = struct.unpack("<HH", data[6:10])
            suffix, mime = ".gif", "image/gif"
        elif data.startswith(b"BM"):
            if len(data) < 26 or int.from_bytes(data[2:6], "little") > len(data):
                raise ApiError("BMP 图片不完整")
            dib = int.from_bytes(data[14:18], "little")
            if dib == 12:
                width, height = struct.unpack("<HH", data[18:22])
            elif dib >= 40 and len(data) >= 54:
                width, raw_height = struct.unpack("<ii", data[18:26])
                height = abs(raw_height)
            suffix, mime = ".bmp", "image/bmp"
        elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            if len(data) < 20 or int.from_bytes(data[4:8], "little") + 8 != len(data):
                raise ApiError("WebP 图片长度无效")
            offset = 12
            has_pixels = False
            while offset + 8 <= len(data):
                kind = data[offset:offset + 4]
                length = int.from_bytes(data[offset + 4:offset + 8], "little")
                start = offset + 8
                if start + length > len(data):
                    raise ApiError("WebP 图片被截断")
                payload = data[start:start + length]
                if kind == b"VP8X" and length >= 10:
                    width = 1 + int.from_bytes(payload[4:7], "little")
                    height = 1 + int.from_bytes(payload[7:10], "little")
                elif kind == b"VP8 " and length >= 10 and payload[3:6] == b"\x9d\x01\x2a":
                    has_pixels = True
                    if not width:
                        width, height = (value & 0x3fff for value in struct.unpack("<HH", payload[6:10]))
                elif kind == b"VP8L" and length >= 5 and payload[0] == 0x2f:
                    has_pixels = True
                    bits = int.from_bytes(payload[1:5], "little")
                    if not width:
                        width, height = 1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)
                elif kind == b"ANMF" and length >= 16:
                    has_pixels = True
                offset = start + length + (length & 1)
            if not has_pixels:
                raise ApiError("WebP 缺少图像数据")
            suffix, mime = ".webp", "image/webp"
        elif len(data) >= 16 and data[4:8] == b"ftyp":
            boxes = _bmff_boxes(data)
            ftyp = next((payload for kind, payload in boxes if kind == b"ftyp"), b"")
            brands = {ftyp[:4]} | {ftyp[i:i + 4] for i in range(8, len(ftyp), 4)}
            if not brands.intersection({b"avif", b"avis"}):
                raise ApiError("ISO-BMFF 文件不是 AVIF 图片，可能是视频")
            if not any(kind in {b"mdat", b"idat"} and payload for kind, payload in boxes):
                raise ApiError("AVIF 缺少图像数据")
            ispe = next((payload for kind, payload in boxes if kind == b"ispe" and len(payload) >= 12), None)
            if ispe is None:
                raise ApiError("AVIF 缺少有效尺寸")
            width, height = struct.unpack(">II", ispe[4:12])
            suffix, mime = ".avif", "image/avif"
        else:
            raise ApiError("返回内容不是支持的图片格式，拒绝保存 HTML、JSON、视频或未知数据")
    except (struct.error, IndexError, ValueError) as exc:
        raise ApiError("图片头或容器结构无效") from exc
    if not (width > 0 and height > 0 and width <= 32768 and height <= 32768 and width * height <= MAX_IMAGE_PIXELS):
        raise ApiError("图片尺寸无效或超出本地安全像素限制")
    return ImageInfo(suffix, mime, width, height)


def sniff_suffix(data: bytes) -> str:
    try:
        return validate_image(data).suffix
    except ApiError:
        return ""


def unique_path(path: Path) -> Path:
    candidate, index = path, 2
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}-{index}{path.suffix or '.png'}")
        index += 1
    return candidate


def output_base(out: str | None, description: str) -> Path:
    if out:
        return Path(out).expanduser().resolve()
    folder = Path.cwd() if Path.cwd().name == "codex生图" else Path.cwd() / "codex生图"
    return folder / f"{_dt.date.today().strftime('%y%m%d')}-{_safe_description(description)}.png"


def save_images(
    images: list[bytes], out: str | None, description: str,
    *, start_index: int = 1, total: int | None = None,
) -> list[str]:
    base_path = output_base(out, description)
    paths: list[str] = []
    for index, image in enumerate(images, start=start_index):
        info = validate_image(image)
        stem = base_path.stem if (total or len(images)) == 1 else f"{base_path.stem}-{index}"
        candidate = base_path.with_name(stem + info.suffix)
        candidate.parent.mkdir(parents=True, exist_ok=True)
        while True:
            candidate = unique_path(candidate)
            try:
                with candidate.open("xb") as handle:
                    handle.write(image)
                    handle.flush()
                    os.fsync(handle.fileno())
                break
            except FileExistsError:
                continue
        paths.append(str(candidate))
    return paths


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="通过 pai.zaiduyu.top 使用多种生图模型")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--models", action="store_true", help="列出实时生图模型、单张积分和当前余额，不生成图片")
    actions.add_argument("--plan", action="store_true", help="只展示所选模型和本次积分预检，不生成图片")
    actions.add_argument("--balance", action="store_true", help="查询总积分、永久积分和限时积分")
    actions.add_argument("--history", action="store_true", help="查询积分交易和模型用量记录")
    actions.add_argument("--checkin", action="store_true", help="手动签到，不会在生图时自动触发")
    parser.add_argument("--makeup", metavar="YYYY-MM-DD", help="补签指定日期，需要站点启用补签且剩余机会大于 0")
    parser.add_argument("--prompt", help="文生图或图片编辑提示词")
    parser.add_argument(
        "--image",
        action="append",
        nargs="+",
        metavar="PATH",
        help=f"本地参考图，可传多张（最多 {MAX_REFERENCE_IMAGES} 张）；与 --prompt 一起使用时执行图片编辑，首张为主图",
    )
    parser.add_argument("--out", help="输出文件路径；不指定时保存到当前目录的 codex生图")
    parser.add_argument("--description", help="文件名简述，最多 10 个字符")
    parser.add_argument("--ratio", choices=tuple(RATIO_SIZES), help="图片比例")
    parser.add_argument("--size", help="固定尺寸，或 宽x高（例如 2048x2048）；与 --ratio、--resolution 三选一")
    parser.add_argument(
        "--resolution",
        choices=tuple(RESOLUTION_TIERS),
        help="分辨率档位 1K/2K/4K，按比例放大；与 --size 二选一，未指定比例时用 1:1",
    )
    parser.add_argument("--quality", choices=QUALITY_CHOICES, help="质量档位；不传则用上游默认值")
    parser.add_argument("--n", type=int, default=1, help=f"生成张数，默认 1，最多 {MAX_IMAGES}；超过 3 张按网站 3 并发分批提交")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="单次请求或任务总超时秒数")
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES, help="临时 HTTP 错误的最大重试次数")
    parser.add_argument("--warn-balance", type=float, default=0, help="余额低于此值时提醒，默认只在余额为 0 时提醒")
    parser.add_argument("--strict-balance", action="store_true", help="余额不足时不提交生图请求")
    parser.add_argument("--history-limit", type=int, default=10, help="每类历史记录最多显示条数")
    parser.add_argument("--async", dest="use_async", action="store_true", help="强制走网站异步任务接口（站点已下线该接口，仅在兼容旧行为时使用；默认直接同步请求上游）")
    parser.add_argument("--sync", dest="use_sync", action="store_true", help="兼容旧参数：站点异步任务接口已下线，脚本默认就走同步接口")
    parser.add_argument("--model", help="模型 ID 或显示名，例如 gpt-image-2、Z-image、Banana 4k；先用 --models 查看")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.timeout <= 0 or args.retries < 0 or args.history_limit <= 0:
        raise SystemExit("--timeout、--history-limit 必须大于 0，--retries 不能小于 0。")
    if not 1 <= args.n <= MAX_IMAGES:
        raise SystemExit(f"--n 取值范围为 1 到 {MAX_IMAGES}。")
    if args.makeup:
        try:
            _dt.date.fromisoformat(args.makeup)
        except ValueError:
            raise SystemExit("--makeup 需要 YYYY-MM-DD 格式的日期。") from None
    cookie = login(args.timeout)
    if args.balance or args.history:
        credits = get_credits(cookie, args.timeout, args.retries)
        if args.balance:
            print_balance(credits)
        else:
            print_history(credits, args.history_limit)
        return
    if args.checkin:
        checkin(cookie, args.timeout, args.retries)
        return
    if args.makeup:
        makeup_checkin(cookie, args.timeout, args.retries, args.makeup)
        return
    config = get_site_config(cookie, args.timeout, args.retries)
    credits = get_credits(cookie, args.timeout, args.retries)
    catalog = build_model_catalog(config, credits)
    if args.models:
        print_model_catalog(catalog, credits, config)
        return
    if not args.prompt:
        raise SystemExit("生图或编辑必须提供 --prompt；查询账户请使用 --models、--balance、--history、--checkin 或 --makeup。")
    model_info = resolve_model(catalog, args.model, config)
    size = resolve_size(args.ratio, args.size, args.resolution)
    references = load_reference_images([item for group in (args.image or []) for item in group])
    print_request_preflight(model_info, args.n, credits, config, size=size)
    if references:
        print(f"参考图：{len(references)} 张（首张为主图）", file=sys.stderr)
    if args.plan:
        return
    check_request_balance(model_info, args.n, credits, args.warn_balance, args.strict_balance)
    model_id = model_info["model"]
    if references:
        images = edit_image(
            cookie, references, args.prompt, args.n, size, model_id,
            args.timeout, args.retries, config, args.quality,
        )
    else:
        payload = generation_payload(
            args.prompt, args.n, size, model_id, config,
            args.ratio or args.size or args.resolution
            if image_route_kind(config, model_id, "generation") == "chat" else None,
            args.quality,
        )
        route_kind = image_route_kind(config, model_id, "generation")
        # 站点已下线异步任务接口（/api/image-jobs 返回 409，提示改为直接请求上游），
        # 因此图片链路默认直接走同步接口；--async 才尝试旧异步任务，失败自动回退同步。
        if route_kind == "chat" or not args.use_async:
            images = direct_generate(cookie, payload, args.n, args.timeout, args.retries, config)
        else:
            try:
                images = async_generate(cookie, payload, args.n, args.timeout, args.retries, config)
            except ApiError as exc:
                if exc.status not in ASYNC_FALLBACK_STATUSES:
                    raise
                print(
                    f"异步任务接口不可用（HTTP {exc.status}），自动回退同步生图接口。",
                    file=sys.stderr,
                )
                images = direct_generate(cookie, payload, args.n, args.timeout, args.retries, config)
    for path in save_images(images, args.out, args.description or args.prompt):
        print(path)


if __name__ == "__main__":
    try:
        main()
    except (ApiError, urllib.error.HTTPError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
