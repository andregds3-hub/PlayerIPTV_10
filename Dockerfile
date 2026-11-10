# PlayerIPTV — imagem para servir o app (arquivos estáticos) com nginx.
# Toda a lógica roda no navegador/TV do usuário: o container só entrega
# index.html, style.css, app.js e lib/hls.min.js.
FROM nginx:1.27-alpine

# Configuração do site (substitui a padrão do nginx)
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Arquivos do app
COPY tizen-app/ /usr/share/nginx/html/

EXPOSE 80

# Marca o container como "unhealthy" se o nginx parar de responder
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
