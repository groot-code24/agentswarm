import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (local dev database) ships its own WebAssembly files; load it from node_modules.
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
};

export default nextConfig;
