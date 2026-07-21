FROM node:current-alpine

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

# Install application dependencies
COPY package.json yarn.lock ./
COPY patches ./patches
RUN yarn install --frozen-lockfile --quiet \
  && yarn cache clean

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