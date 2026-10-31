"""Decode a bounded FairyGUI XML document with Python's installed stdlib.

No filesystem, network, dependency installation or third-party XML code.  The
Node caller uses isolated Python (-I -S) and communicates only through stdin.
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET

MAX_BYTES = 1_000_000
MAX_NODES = 2048
MAX_DEPTH = 32
MAX_ATTRIBUTES = 256


class XmlBridgeError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def decode(text: str) -> dict:
    """Preserve element order and string attributes; omit comments/text nodes."""
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise XmlBridgeError("UI_XML_LIMIT", "XML 大小超过 1 MB 预算。")
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.IGNORECASE):
        raise XmlBridgeError("UI_XML_DTD", "XML 不允许 DTD 或实体声明。")
    parser = ET.XMLPullParser(events=("start", "end"))
    root = None
    count = 0
    depth = 0
    for start in range(0, len(text), 16384):
        parser.feed(text[start : start + 16384])
        for event, element in parser.read_events():
            if event == "end":
                depth -= 1
                continue
            count += 1
            depth += 1
            if count > MAX_NODES or depth > MAX_DEPTH:
                raise XmlBridgeError("UI_XML_LIMIT", "XML 节点或嵌套深度超过预算。")
            if len(element.attrib) > MAX_ATTRIBUTES:
                raise XmlBridgeError("UI_XML_LIMIT", "XML 单节点属性超过预算。")
            names = [element.tag, *element.attrib]
            if any("{" in name or ":" in name for name in names):
                raise XmlBridgeError("UI_XML_SCHEMA", "首版不支持 XML 命名空间。")
            if root is None:
                root = element
    parser.close()
    if root is None:
        raise XmlBridgeError("UI_XML_SYNTAX", "XML 没有根元素。")

    def project(element: ET.Element) -> dict:
        return {
            "tag": element.tag,
            "attrs": dict(element.attrib),
            "children": [project(child) for child in element],
        }

    return project(root)


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise XmlBridgeError("UI_XML_LIMIT", "XML 大小超过 1 MB 预算。")
        text = raw.decode("utf-8-sig", errors="strict")
        result = {"ok": True, "root": decode(text)}
    except XmlBridgeError as error:
        result = {"ok": False, "code": error.code, "error": str(error)}
    except (ET.ParseError, UnicodeError) as error:
        result = {"ok": False, "code": "UI_XML_SYNTAX", "error": f"XML 解码失败：{error}"}
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
