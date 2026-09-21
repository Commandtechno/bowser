// unix seconds - the unit every timestamp column in the db uses
export const nowS = (): number => Math.floor(Date.now() / 1000);
