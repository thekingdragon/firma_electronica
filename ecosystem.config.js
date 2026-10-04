/**
 * PM2: un solo proceso que sirve la API y el panel compilado. Las variables vienen de apps/api/.env
 * (el servicio lo lee desde su directorio de trabajo), no de este archivo: aquí no van secretos.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * Igual que gestor-api de Polix: NO corre en watch. Guardar código no cambia nada en producción hasta
 * que alguien compile y reinicie (npm run build:all  →  pm2 restart firma-api).
 */
module.exports = {
  apps: [
    {
      name: 'firma-api',
      cwd: __dirname + '/apps/api',
      script: 'dist/main.js',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      // Da tiempo a terminar los correos y webhooks en curso antes de cortar (apagado ordenado).
      kill_timeout: 15000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
