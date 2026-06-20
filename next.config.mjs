/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      { source: "/", destination: "/index.html" },
      { source: "/login", destination: "/index.html" },
      { source: "/home", destination: "/home.html" },
      { source: "/game", destination: "/game.html" },
      { source: "/payment", destination: "/payment.html" },
      { source: "/profile", destination: "/profile.html" },
      { source: "/telegram-verify", destination: "/telegram-verify.html" },
      { source: "/game-link", destination: "/game-link.html" },
    ]
  },
}

export default nextConfig
