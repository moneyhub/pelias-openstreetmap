# Pelias Multi-Instance Setup

This repository supports running multiple Pelias Elasticsearch instances for different datasets (London and UK).

## Architecture

- **Port 9200**: External Elasticsearch (Foursquare/OSM data) - used by `postcodeEnricher.js` for enrichment
- **Port 9201**: Pelias Elasticsearch for London data
- **Port 9202**: Pelias Elasticsearch for UK data

## Docker Setup

**Note**: The external Elasticsearch (port 9200) for Foursquare/OSM data is managed separately from another repository and should be running independently.

### Starting All Services

```bash
docker-compose up -d
```

This will start:

- `pelias_elasticsearch_london` on port 9201 (London Pelias data)
- `pelias_elasticsearch_uk` on port 9202 (UK Pelias data)

### Starting Individual Services

```bash
# Start only London Pelias ES
docker-compose up -d elasticsearch-pelias-london

# Start only UK Pelias ES
docker-compose up -d elasticsearch-pelias-uk
```

### Stopping Services

```bash
# Stop all
docker-compose down

# Stop specific service
docker-compose stop elasticsearch-pelias-london
```

## Indexing Data

### Indexing London Data

```bash
./reindex.sh london
```

This will:

1. Use `config/pelias/london.json` config (points to port 9201)
2. Import `greater-london-260202.osm.pbf`
3. Create log file: `import-london.log`

### Indexing UK Data

```bash
./reindex.sh uk
```

This will:

1. Use `config/pelias/uk.json` config (points to port 9202)
2. Import `united-kingdom-latest.osm.pbf`
3. Create log file: `import-uk.log`

## Running Experiments

### Query London Pelias Index

```bash
node analysis/index.js --store-results --name "london_experiment" --pelias-instance london
```

### Query UK Pelias Index

```bash
node analysis/index.js --store-results --name "uk_experiment" --pelias-instance uk
```

### Query External Index (for testing)

```bash
node analysis/index.js --store-results --name "external_test" --pelias-instance external
```

## Configuration Files

- `~/pelias.json` - Active config (copied from dataset-specific config during reindex)
- `config/pelias/london.json` - London dataset config (port 9201)
- `config/pelias/uk.json` - UK dataset config (port 9202)

**Note**: Pelias reads configuration from `~/pelias.json` in your home directory. The `reindex.sh` script automatically copies the appropriate config file to `~/pelias.json` before indexing.

## Notes

- The `postcodeEnricher.js` always queries the external Elasticsearch (port 9200) for enrichment data - this is managed separately from another repository
- The analysis scripts query whichever Pelias instance you specify
- Each Pelias instance has its own Docker volume for data persistence
- Make sure the external Elasticsearch (port 9200) is running before indexing, as it's required for postcode enrichment
