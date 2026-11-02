# syntax=docker/dockerfile:1
ARG NODE_VERSION=26
ARG GO_VERSION=1

FROM golang:${GO_VERSION}-trixie AS osl
ARG OSL_REPO=https://git.rotur.dev/osl/.go
ARG OSL_REF=c24c464307ca00ff93fa7f5c88c55f5431abd597
RUN git init -q /osl && cd /osl && git remote add origin "$OSL_REPO" \
    && git fetch -q --depth 1 origin "$OSL_REF" && git checkout -q FETCH_HEAD \
    && go build -o /usr/local/bin/osl .

FROM node:${NODE_VERSION}-trixie-slim AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git gh tar unzip procps xauth \
    chromium fonts-liberation xvfb \
    build-essential cmake ninja-build pkg-config \
    libcurl4-openssl-dev libdbus-1-dev libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libxi-dev \
    libgl1-mesa-dev libasound2-dev libsdl2-dev librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=osl /usr/local/go /usr/local/go
COPY --from=osl /usr/local/bin/osl /usr/local/bin/osl
ENV PATH=/usr/local/go/bin:$PATH \
    CHROME=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1 \
    SDL_AUDIODRIVER=dummy \
    BENCH_REPO_DIR=/app \
    BENCH_RESULTS_DIR=/app/results \
    HOME=/home/node

WORKDIR /app
RUN mkdir -p /app/.cache /app/results /home/node/.cache && chown -R node:node /app /home/node

FROM base AS app
USER node
COPY --chown=node:node package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=node:node site/package.json site/bun.lock site/
RUN cd site && bun install --frozen-lockfile
COPY --chown=node:node . .
RUN test -d parity/project || { echo "parity/ is empty: run 'git submodule update --init' before building" >&2; exit 1; }

ARG BENCH_CRON="0 3 * * *"
RUN cd site && BENCH_CRON="$BENCH_CRON" bun run build

ARG BENCH_REPO_SHA=
ARG BENCH_PARITY_SHA=
ENV BENCH_REPO_SHA=$BENCH_REPO_SHA BENCH_PARITY_SHA=$BENCH_PARITY_SHA \
    PORT=3000 HOST=0.0.0.0
EXPOSE 3000
VOLUME ["/app/results", "/app/.cache"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve"]
