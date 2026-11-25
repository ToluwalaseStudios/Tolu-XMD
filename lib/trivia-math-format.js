const COMMANDS = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  theta: "θ", lambda: "λ", mu: "μ", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", phi: "φ", omega: "ω",
  Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ",
  Phi: "Φ", Omega: "Ω",
  times: "×", cdot: "·", pm: "±", mp: "∓", div: "÷",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠",
  approx: "≈", equiv: "≡", infty: "∞", degree: "°",
 rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐",
  sum: "Σ", prod: "Π", int: "∫", partial: "∂",
  sqrt: "√", ell: "ℓ"
};

const SUPER = { "0":"⁰", "1":"¹", "2":"²", "3":"³", "4":"⁴", "5":"⁵", "6":"⁶", "7":"⁷", "8":"⁸", "9":"⁹", "+":"⁺", "-":"⁻", "=":"⁼", "(":"⁽", ")":"⁾", "n":"ⁿ", "i":"ⁱ" };
const SUB = { "0":"₀", "1":"₁", "2":"₂", "3":"₃", "4":"₄", "5":"₅", "6":"₆", "7":"₇", "8":"₈", "9":"₉", "+":"₊", "-":"₋", "=":"₌", "(":"₍", ")":"₎", "a":"ₐ", "e":"ₑ", "i":"ᵢ", "o":"ₒ", "x":"ₓ", "n":"ₙ" };

function readGroup(source, start) {
  if (source[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { value: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function mapScript(value, mapping) {
  return [...value].map(char => mapping[char] || char).join("");
}

function replaceFractions(source) {
  let text = source;
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    text = text.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, numerator, denominator) => {
      changed = true;
      return "(" + numerator + ")/(" + denominator + ")";
    });
    if (!changed) break;
  }
  return text;
}

function replaceRoots(source) {
  let text = source;
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    text = text.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, value) => {
      changed = true;
      return "√(" + value + ")";
    });
    if (!changed) break;
  }
  return text;
}

function replaceScripts(source) {
  let text = source;
  for (let pass = 0; pass < 12; pass += 1) {
    const next = text
      .replace(/\^\s*\{([^{}]*)\}/g, (_, value) => mapScript(value, SUPER))
      .replace(/_\s*\{([^{}]*)\}/g, (_, value) => mapScript(value, SUB));
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/\^([0-9+\-=])/g, (_, value) => mapScript(value, SUPER))
    .replace(/_([0-9])/g, (_, value) => mapScript(value, SUB));
}

/**
 * Converts common LaTeX math notation into readable Unicode/plain text for
 * WhatsApp. WhatsApp does not typeset TeX; this formatter deliberately keeps
 * the result as ordinary text so it remains searchable and accessible.
 */
export function formatTriviaMath(value) {
  let text = String(value ?? "");
  if (!text) return text;

  text = text
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
    .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
    .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|textrm|textbf)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:,|;|:|!|quad|qquad|enspace|thinspace)\b?/g, " ")
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/\\#/g, "#");

  text = replaceFractions(text);
  text = replaceRoots(text);
  text = replaceScripts(text);

  text = text.replace(/\\([A-Za-z]+)\b/g, (match, command) =>
    Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : command
  );

  text = text
    .replace(/\\\s/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

  return text;
}
