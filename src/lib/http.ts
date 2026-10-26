// response helpers shared by the api routes and the client scripts that call them

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// client side: the `error` an api route sent back via json() above, or the fallback when there isn't one
export const errorMessage = async (res: Response, fallback: string): Promise<string> =>
  ((await res.json().catch(() => ({}))) as { error?: string }).error ?? fallback;

// returns the 403 to send back, or null when the caller is an admin
export const requireAdmin = (locals: App.Locals): Response | null =>
  locals.user?.role === "admin" ? null : json(403, { error: "admin only" });
