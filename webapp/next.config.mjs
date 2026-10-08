/** @type {import('next').NextConfig} */
const nextConfig = {
  // Production keeps the default ".next". The staging instance is launched with
  // NEXT_DIST_DIR=.next-staging so it builds/serves from a SEPARATE directory,
  // leaving production's .next completely untouched. When the env var is unset
  // (production) distDir is undefined => Next's ".next" default, identical to before.
  distDir: process.env.NEXT_DIST_DIR || undefined,
};

export default nextConfig;
