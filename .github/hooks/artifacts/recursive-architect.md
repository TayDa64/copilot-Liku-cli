## Recommended Approach
Use the ai-service extraction seam and keep the compatibility facade stable.

## Files to Reuse
- src/main/ai-service.js
- src/main/ai-service/visual-context.js

## Constraints and Risks
- Source-based regression tests inspect ai-service.js text directly.