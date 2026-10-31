// 命令行的统一报错：错误码 + 说明 + 文件和行号（如果有）+ 下一步怎么改。错误码表见 references/error-codes.md。
export class LgCliError extends Error {
  constructor(code, message, {file, line, fix} = {}) {
    super(message);
    this.name = 'LgCliError';
    this.code = code;
    this.file = file;
    this.line = line;
    this.fix = fix;
  }

  // --json 输出里 errors 数组的一项。
  toJSON() {
    return {code: this.code, message: this.message, file: this.file ?? null, line: this.line ?? null, fix: this.fix ?? null};
  }
}

// 一次报出多条错误（比如工程配置里有好几个字段不对）。
export class LgCliErrors extends Error {
  constructor(errors) {
    super(errors.map(error => error.message).join('\n'));
    this.name = 'LgCliErrors';
    this.errors = errors;
  }
}
