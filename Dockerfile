# Official Playwright image ships Chromium/Firefox/WebKit + all system deps preinstalled.
# IMPORTANT: this tag's version must exactly match the "playwright" version pinned
# in package.json (no caret/range there) - the npm package and the browser
# binaries baked into this image have to be the same version or the container
# fails at launch with "Executable doesn't exist". If you bump one, bump both.
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

# ffmpeg is needed to convert Playwright's .webm output to .mp4
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

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
