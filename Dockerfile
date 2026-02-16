# base image
FROM pelias/baseimage

# downloader apt dependencies
# note: this is done in one command in order to keep down the size of intermediate containers
RUN apt-get update && apt-get install -y bzip2 unzip && rm -rf /var/lib/apt/lists/*

# change working dir
ENV WORKDIR /code/pelias/openstreetmap
WORKDIR ${WORKDIR}

ARG NPM_TOKEN
ENV NPM_TOKEN=$NPM_TOKEN
COPY .npmrc ${WORKDIR}

# copy package.json first to prevent npm install being rerun when only code changes
COPY ./package.json ${WORKDIR}
# Install only production dependencies (excludes devDependencies like pelias-schema)
RUN npm install --production

# add local code
ADD . ${WORKDIR}

# Skip tests in Docker (devDependencies not installed, and tests run in CI/local)
# Clean up LevelDB lockfile
RUN rm -rf /tmp/*

RUN rm .npmrc

# run as the pelias user
USER pelias
