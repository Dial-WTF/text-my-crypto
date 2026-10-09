/**
 * The Dial operator's phone line, used when DIAL_OPERATOR_NUMBER is unset. Lives on its own so client
 * components (the error pages) can link to it without pulling the env schema into the browser bundle.
 */
export const DEFAULT_OPERATOR_NUMBER = "+18066071387";
