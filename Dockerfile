FROM node:22.14.0-alpine

# Add deploy user
RUN adduser -D -g '' deploy

# Set up working directory
RUN mkdir /app
RUN chown deploy:deploy /app

WORKDIR /app

# Install system dependencies
RUN apk update && apk add --no-cache --quiet \
  build-base \
  dumb-init

# Enable Corepack so the project's pinned Yarn 4 is used
RUN corepack enable

# Install application dependencies
COPY package.json yarn.lock .yarnrc.yml ./
# COPY patches ./patches
RUN yarn install --immutable \
  && rm -rf .yarn/cache

# Copy application code
COPY --chown=deploy:deploy . /app

# Build application
# Update file/directory permissions
RUN yarn build \
  && chown -R deploy:deploy ./

# Switch to less-privileged user
USER deploy

ENTRYPOINT ["/usr/bin/dumb-init", "./scripts/load_secrets_and_run.sh"]
CMD ["yarn", "start"]