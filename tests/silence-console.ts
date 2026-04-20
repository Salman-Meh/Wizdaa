/**
 * Suppress console output during test runs.
 * Error-path tests produce expected console.error noise from production code's catch blocks.
 * Comment out specific lines for debugging if needed.
 */
const noop = () => {};
global.console.log = noop as any;
global.console.error = noop as any;
global.console.warn = noop as any;
