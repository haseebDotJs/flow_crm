import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a production build run without touching a running dev server's `.next` folder.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
