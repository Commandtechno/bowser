// response helpers shared by the api routes

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// returns the 403 to send back, or null when the caller is an admin
export const requireAdmin = (locals: App.Locals): Response | null =>
  locals.user?.role === "admin" ? null : json(403, { error: "admin only" });
