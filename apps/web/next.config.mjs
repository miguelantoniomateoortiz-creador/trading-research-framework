/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El dashboard sólo lee/escribe a través de @trf/api (127.0.0.1:4319).
  // No hay rutas de servidor propias que toquen la base de datos: eso
  // mantendría la lógica de análisis duplicada entre CLI y web.
};

export default nextConfig;
