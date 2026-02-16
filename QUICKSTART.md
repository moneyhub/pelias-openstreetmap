# Quick Start Guide

## Initial Setup

### 1. Start the Pelias Elasticsearch Containers

```bash
docker-compose up -d
```

This starts:

- London Pelias ES on port **9201**
- UK Pelias ES on port **9202**

**Note**: Make sure your external Elasticsearch (Foursquare/OSM data) is running on port **9200** from your other repository.

### 2. Verify Containers are Running

```bash
docker ps | grep pelias
```

You should see:

- `pelias_elasticsearch_london`
- `pelias_elasticsearch_uk`

## Indexing Data

### Index London Data

```bash
./reindex.sh london
```

This will:

- Use `config/pelias/london.json` config (port 9201)
- Import `greater-london-260202.osm.pbf`
- Create log: `import-london.log`
- Copy config to `~/pelias.json`

**Time**: ~10-30 minutes depending on your machine

### Index UK Data

```bash
./reindex.sh uk
```

This will:

- Use `config/pelias/uk.json` config (port 9202)
- Import `united-kingdom-latest.osm.pbf`
- Create log: `import-uk.log`
- Copy config to `~/pelias.json`

**Time**: Several hours (UK is much larger)

## Running Experiments

### Query London Pelias Index

```bash
node analysis/index.js --store-results --name "london_experiment_1" --pelias-instance london
```

### Query UK Pelias Index

```bash
node analysis/index.js --store-results --name "uk_experiment_1" --pelias-instance uk
```

### With Region Filter (London only)

```bash
node analysis/index.js --store-results --name "london_filtered" --pelias-instance london --filter-region "london"
```

### With Debug Output

```bash
node analysis/index.js --store-results --name "debug_test" --pelias-instance london --debug
```

## Common Workflows

### Workflow 1: Quick Iteration with London Data

```bash
# 1. Start containers
docker-compose up -d

# 2. Index London data (if not already done)
./reindex.sh london

# 3. Run experiment
node analysis/index.js --store-results --name "london_test" --pelias-instance london

# 4. Check results
cat analysis/evaluation_results/experiments_summary.csv
```

### Workflow 2: Full UK Evaluation

```bash
# 1. Make sure containers are running
docker-compose up -d

# 2. Index UK data (this takes hours!)
./reindex.sh uk

# 3. Run experiment against UK index
node analysis/index.js --store-results --name "uk_full" --pelias-instance uk

# 4. View results
cat analysis/evaluation_results/experiments_summary.csv
```

### Workflow 3: Compare London vs UK

```bash
# Index both (do this separately, UK takes much longer)
./reindex.sh london
./reindex.sh uk

# Run experiments
node analysis/index.js --store-results --name "london_comparison" --pelias-instance london
node analysis/index.js --store-results --name "uk_comparison" --pelias-instance uk

# Compare results
cat analysis/evaluation_results/experiments_summary.csv
```

## Monitoring Progress

### During Indexing

```bash
# Watch London import progress
tail -f import-london.log

# Watch UK import progress
tail -f import-uk.log

# Check document count (London)
curl -s "localhost:9201/pelias/_count" | python3 -c "import sys, json; print(json.load(sys.stdin)['count'])"

# Check document count (UK)
curl -s "localhost:9202/pelias/_count" | python3 -c "import sys, json; print(json.load(sys.stdin)['count'])"
```

### Check Container Status

```bash
# View logs
docker-compose logs -f elasticsearch-pelias-london
docker-compose logs -f elasticsearch-pelias-uk

# Check health
curl localhost:9201/_cluster/health
curl localhost:9202/_cluster/health
```

## Troubleshooting

### Containers won't start

```bash
# Check if ports are already in use
lsof -i :9201
lsof -i :9202

# Stop and remove containers
docker-compose down

# Start fresh
docker-compose up -d
```

### Reindex fails

```bash
# Check Elasticsearch is accessible
curl localhost:9201
curl localhost:9202

# Check config was copied correctly
cat ~/pelias.json

# Check import log for errors
tail -50 import-london.log
```

### Experiment returns no results

```bash
# Verify the correct Pelias instance is running
curl localhost:9201/pelias/_count  # London
curl localhost:9202/pelias/_count  # UK

# Check you're querying the right instance
node analysis/index.js --pelias-instance london --debug
```

## File Locations

- **Configs**: `config/pelias/*.json` (project profiles)
- **Active Config**: `~/pelias.json` (home directory, auto-updated by reindex.sh)
- **Import Logs**: `import-london.log`, `import-uk.log` (project root)
- **Results**: `analysis/evaluation_results/` (JSON files and summary CSV)

## Tips

1. **London is faster**: Use London for quick iterations and testing
2. **UK takes time**: UK indexing can take several hours - plan accordingly
3. **Check logs**: Always check `import-*.log` if something goes wrong
4. **Backup configs**: Your `~/pelias.json` gets overwritten - the project configs are your source of truth
5. **External ES**: Remember the external Elasticsearch (port 9200) must be running for postcode enrichment to work
