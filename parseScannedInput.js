// Parse scanner input: 14-digit codes always start with the fixed "02050" prefix,
// e.g. "02050-10153588-6". Skip the first 5 digits (prefix) and the last 1 digit
// (check digit) — the middle 8 digits are the SKU looked up in the database.
// Anything else (manual typing) is treated as a literal SKU.
function parseScannedInput(raw) {
  const trimmed = (raw || '').trim();
  const digitsOnly = trimmed.replace(/[\s-]/g, ''); // strip dashes/spaces for the barcode check only
  
  if (/^02050\d{9}$/.test(digitsOnly)) {
    const productCode = digitsOnly.slice(5, 13); // middle 8 digits
    return { mode: 'barcode', sku: productCode.toUpperCase() };
  }
  
  // Not a valid "02050..." 14-digit code — treat as manually-typed SKU
  return { mode: 'manual', sku: trimmed.toUpperCase() };
}

window.parseScannedInput = parseScannedInput;
