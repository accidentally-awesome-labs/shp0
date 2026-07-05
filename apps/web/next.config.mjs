import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo root (apps/web lives two levels under the workspace root).
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  // React Compiler — installed as babel-plugin-react-compiler, auto-wired by Next.
  reactCompiler: true,
  // PPR (Partial Prerendering, renamed cacheComponents in Next 16).
  // Static shell with dynamic holes — the speed differentiator.
  cacheComponents: true,
};

export default nextConfig;
