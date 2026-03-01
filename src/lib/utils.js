export const now = () => Date.now();
export const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
