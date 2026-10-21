export function calculateExpression(value) {
  const source = String(value || "").replaceAll("×", "*").replaceAll("÷", "/").replaceAll("−", "-").replace(/\s+/g, "");
  if (!source || source.length > 256) throw new Error("请输入算式，最多 256 个字符");
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[()+\-*/%]/gi) || [];
  if (tokens.join("") !== source) throw new Error("算式只能包含数字、括号和四则运算符");
  let index = 0;
  function atom() {
    const token = tokens[index++];
    let result;
    if (token === "+" || token === "-") result = (token === "-" ? -1 : 1) * atom();
    else if (token === "(") {
      result = sum();
      if (tokens[index++] !== ")") throw new Error("请补齐括号");
    } else if (token && /^[\d.]/.test(token)) {
      result = Number(token);
      if (Number.isInteger(result) && !Number.isSafeInteger(result)) throw new Error("输入数值超出精确整数范围，请缩小数值");
    }
    else throw new Error("请检查算式中的数字和运算符");
    while (tokens[index] === "%") { index++; result /= 100; }
    return result;
  }
  function product() {
    let result = atom();
    while (tokens[index] === "*" || tokens[index] === "/") {
      const operator = tokens[index++], right = atom();
      if (operator === "/" && right === 0) throw new Error("除数不能为 0");
      result = operator === "*" ? result * right : result / right;
    }
    return result;
  }
  function sum() {
    let result = product();
    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index++], right = product();
      result = operator === "+" ? result + right : result - right;
    }
    return result;
  }
  const result = sum();
  if (index !== tokens.length) throw new Error("请检查括号和运算符");
  if (!Number.isFinite(result)) throw new Error("计算结果过大，请缩小数值范围");
  if (Number.isInteger(result) && !Number.isSafeInteger(result)) throw new Error("计算结果超出精确整数范围，请缩小数值");
  return Number.isInteger(result) ? result.toString() : Number(result.toPrecision(15)).toString();
}
