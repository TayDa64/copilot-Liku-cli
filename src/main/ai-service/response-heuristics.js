function detectTruncation(response) {
  if (!response) return false;

  const truncationSignals = [
    /```json\s*\{[^}]*$/s.test(response),
    (response.match(/```/g) || []).length % 2 !== 0,
    /[a-z,]\s*$/i.test(response) && !/[.!?:]\s*$/i.test(response),
    /\d+\.\s*$/m.test(response),
    /-\s*$/m.test(response),
    (response.match(/\(/g) || []).length > (response.match(/\)/g) || []).length,
    (response.match(/\[/g) || []).length > (response.match(/\]/g) || []).length
  ];

  if (truncationSignals.some(Boolean)) {
    return true;
  }

  if (response.length < 100) return false;

  return truncationSignals.some(Boolean);
}

function shouldAutoContinueResponse(response, containsActions = false) {
  if (containsActions) {
    return false;
  }
  return detectTruncation(response);
}

module.exports = {
  detectTruncation,
  shouldAutoContinueResponse
};