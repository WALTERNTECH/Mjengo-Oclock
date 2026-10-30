// Vercel function for /api/* and /health (see vercel.json). The API itself is in backend/;
// the build compiles it to backend/dist.
export { default } from "../backend/dist/vercel.js";
