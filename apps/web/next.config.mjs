/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@modelforge/db", "@modelforge/billing", "@modelforge/engine"],
};

export default nextConfig;
