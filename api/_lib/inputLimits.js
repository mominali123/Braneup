// api/_lib/inputLimits.js
//
// Shared input-sanitization helper for every /api/generate-* endpoint.
// Caps free-text field lengths BEFORE they're interpolated into the
// brief sent to OpenRouter, so a single oversized field can't inflate
// prompt-token cost or be used to pad/hide instructions deep in a
// giant string. Truncates silently (rather than rejecting) to keep
// the UX forgiving for legitimate long-ish input.
//
// Usage:
//   const { capLength } = require('./_lib/inputLimits');
//   const description = capLength(body.description, 1200);

/**
 * Coerces a value to a trimmed string and truncates it to `max` chars.
 * @param {*} value - raw field from the request body
 * @param {number} max - maximum character length to allow
 * @returns {string}
 */
function capLength(value, max) {
  const str = (value == null ? '' : value).toString().trim();
  return str.length > max ? str.slice(0, max) : str;
}

module.exports = { capLength };
