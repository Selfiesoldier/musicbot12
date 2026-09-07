FROM denoland/deno:bin AS deno_bin
FROM brainicism/bgutil-ytdlp-pot-provider:latest AS pot_provider
FROM node:20-bookworm-slim

# 1. Copy official Deno binary for EJS YouTube challenge solving
COPY --from=deno_bin /deno /usr/local/bin/deno

# 2. Copy prebuilt bgutil PO Token provider for Botguard challenges
COPY --from=pot_provider /app /app/pot-provider

# 3. Install system dependencies: FFmpeg, Python3, python3-pip, ca-certificates, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# 4. Copy package descriptors and install dependencies
COPY package*.json requirements.txt ./
RUN npm install --omit=dev \
    && pip3 install --break-system-packages --no-cache-dir -U curl_cffi bgutil-ytdlp-pot-provider -r requirements.txt \
    && mkdir -p /usr/local/share/yt-dlp/plugins \
    && ln -s $(python3 -c "import site; print(site.getsitepackages()[0])")/yt_dlp_plugins /usr/local/share/yt-dlp/plugins/bgutil-ytdlp-pot-provider

# 5. Copy full application files
COPY . .

# 6. Configure system-wide yt-dlp config and directories
RUN cp yt-dlp.conf /etc/yt-dlp.conf \
    && mkdir -p cache tts_cache logs \
    && chmod +x start.sh

# 7. Default environment
ENV PORT=10000
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

EXPOSE 10000

CMD ["./start.sh"]
