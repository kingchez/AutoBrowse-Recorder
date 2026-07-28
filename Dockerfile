# Official Playwright image ships Chromium/Firefox/WebKit + all system deps preinstalled.
# Pin to a version that matches the playwright npm package in package.json.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# ffmpeg is needed to convert Playwright's .webm output to .mp4
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Where in-progress/finished job files and saved login sessions live
RUN mkdir -p /app/data/jobs /app/data/sessions

ENV PORT=3000
ENV JOBS_DIR=/app/data/jobs
ENV SESSIONS_DIR=/app/data/sessions
# Auto-prune undelivered outputs after this many hours
ENV PRUNE_AFTER_HOURS=48

EXPOSE 3000

CMD ["node", "src/server.js"]
