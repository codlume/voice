import type { MiddlewareHandler } from "astro";

import { securityHeaders } from "./headers.ts";

export const onRequest: MiddlewareHandler = async (_context, next) => {
  const response = await next();
  // The dev server's own scripts, Vite's client and the toolbar, would not pass the CSP.
  if (import.meta.env.PROD)
    for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
  return response;
};
