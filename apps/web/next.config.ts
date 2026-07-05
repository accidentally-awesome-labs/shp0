import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Monorepo root (apps/web lives two levels under the workspace root).
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  // React Compiler — installed as babel-plugin-react-compiler, auto-wired by Next.
  experimental: {
    reactCompiler: true,
    // Partial Prerendering — static shell with dynamic holes (the speed flex).
    ppr: true,
  },
};

export default nextConfig;
