#!/bin/bash

set -e

# Parse arguments
DATASET="${1:-london}"  # Default to 'london' if not specified
BASELINE="${2:-false}"  # Default to false (with enrichment)
POSTCODE_ESTIMATION="${3:-false}"  # Default to false (no postcode estimation)

if [ "$DATASET" != "london" ] && [ "$DATASET" != "uk" ]; then
    echo "ERROR: Dataset must be 'london' or 'uk'"
    echo "Usage: ./reindex.sh [london|uk] [baseline] [postcode_estimation]"
    echo "  Examples:"
    echo "    ./reindex.sh london                    # London with postcode enrichment"
    echo "    ./reindex.sh london baseline           # London baseline (no enrichment)"
    echo "    ./reindex.sh uk                        # UK with postcode enrichment"
    echo "    ./reindex.sh uk baseline               # UK baseline (no enrichment)"
    echo "    ./reindex.sh uk false postcode_estimation           # UK with postcode estimation (fallback mode)"
    echo "    ./reindex.sh uk false postcode_estimation_prelookup  # UK with postcode estimation (prelookup mode)"
    exit 1
fi

# Set configuration based on dataset, baseline flag, and postcode estimation
if [ "$DATASET" == "london" ]; then
    if [ "$BASELINE" == "baseline" ]; then
        ELASTICSEARCH_HOST="localhost:9203"
        CONFIG_FILE="pelias-london-baseline.json"
        DATASET_NAME="London (Baseline)"
    else
        ELASTICSEARCH_HOST="localhost:9201"
        CONFIG_FILE="pelias-london.json"
        DATASET_NAME="London"
    fi
else
    if [ "$BASELINE" == "baseline" ]; then
        ELASTICSEARCH_HOST="localhost:9204"
        CONFIG_FILE="pelias-uk-baseline.json"
        DATASET_NAME="UK (Baseline)"
    elif [ "$POSTCODE_ESTIMATION" == "postcode_estimation" ]; then
        ELASTICSEARCH_HOST="localhost:9205"
        CONFIG_FILE="pelias-uk-estimation.json"
        DATASET_NAME="UK (with Postcode Estimation - Fallback)"
    elif [ "$POSTCODE_ESTIMATION" == "postcode_estimation_prelookup" ]; then
        ELASTICSEARCH_HOST="localhost:9206"
        CONFIG_FILE="pelias-uk-estimation-prelookup.json"
        DATASET_NAME="UK (with Postcode Estimation - Prelookup)"
    else
        ELASTICSEARCH_HOST="localhost:9202"
        CONFIG_FILE="pelias-uk.json"
        DATASET_NAME="UK"
    fi
fi

INDEX_NAME="pelias"

echo "=========================================="
echo "Pelias Reindex Script - ${DATASET_NAME}"
echo "=========================================="
echo "Dataset: ${DATASET}"
echo "Elasticsearch: ${ELASTICSEARCH_HOST}"
echo "Config file: ${CONFIG_FILE}"
echo "Postcode estimation: ${POSTCODE_ESTIMATION}"
echo ""

echo "Step 1: Checking Elasticsearch connection..."
if ! curl -s "${ELASTICSEARCH_HOST}" > /dev/null; then
    echo "ERROR: Cannot connect to Elasticsearch at ${ELASTICSEARCH_HOST}"
    echo "Please make sure Elasticsearch is running."
    exit 1
fi
echo "✓ Elasticsearch is accessible"
echo ""

echo "Step 2: Deleting existing index '${INDEX_NAME}'..."
if curl -s -X DELETE "${ELASTICSEARCH_HOST}/${INDEX_NAME}" | grep -q '"acknowledged":true'; then
    echo "✓ Index deleted successfully"
elif curl -s "${ELASTICSEARCH_HOST}/${INDEX_NAME}" | grep -q '"error"'; then
    echo "✓ Index does not exist (nothing to delete)"
else
    echo "⚠ Warning: Could not confirm index deletion, continuing anyway..."
fi
echo ""

echo "Step 3: Generating schema and creating new index..."
# Generate schema using pelias-schema
SCHEMA_JSON=$(node scripts/generate-schema.js)

if [ $? -ne 0 ] || [ -z "$SCHEMA_JSON" ]; then
    echo "ERROR: Failed to generate schema"
    exit 1
fi

INDEX_CREATED=$(curl -s -X PUT "${ELASTICSEARCH_HOST}/${INDEX_NAME}" \
    -H 'Content-Type: application/json' \
    -d "$SCHEMA_JSON")

if echo "$INDEX_CREATED" | grep -q '"acknowledged":true'; then
    echo "✓ Index created successfully"
else
    echo "ERROR: Failed to create index"
    echo "$INDEX_CREATED" | python3 -m json.tool 2>/dev/null || echo "$INDEX_CREATED"
    exit 1
fi
echo ""

echo "Step 4: Preparing config file..."
TEMP_CONFIG=$(mktemp)
cp "${CONFIG_FILE}" "${TEMP_CONFIG}"

# Set postcodeEstimation if requested
# POSTCODE_ESTIMATION can be: "postcode_estimation" (fallback mode) or "postcode_estimation_prelookup" (prelookup mode)
if [ "$POSTCODE_ESTIMATION" == "postcode_estimation" ] || [ "$POSTCODE_ESTIMATION" == "postcode_estimation_prelookup" ]; then
    # Determine estimation mode
    if [ "$POSTCODE_ESTIMATION" == "postcode_estimation_prelookup" ]; then
        ESTIMATION_MODE="prelookup"
    else
        ESTIMATION_MODE="fallback"
    fi
    # Use node to modify JSON - single line with short var names to avoid bash parsing issues
    node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('${TEMP_CONFIG}','utf8'));if(!c.imports)c.imports={};if(!c.imports.openstreetmap)c.imports.openstreetmap={};c.imports.openstreetmap.postcodeEstimation=true;c.imports.openstreetmap.postcodeEstimationMode='${ESTIMATION_MODE}';fs.writeFileSync('${TEMP_CONFIG}',JSON.stringify(c,null,2));"
    echo "✓ Enabled postcode estimation in config (mode: ${ESTIMATION_MODE})"
else
    # Ensure it's explicitly false
    node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('${TEMP_CONFIG}','utf8'));if(!c.imports)c.imports={};if(!c.imports.openstreetmap)c.imports.openstreetmap={};c.imports.openstreetmap.postcodeEstimation=false;fs.writeFileSync('${TEMP_CONFIG}',JSON.stringify(c,null,2));"
fi

cp "${TEMP_CONFIG}" ~/pelias.json
rm "${TEMP_CONFIG}"
echo "✓ Copied config to ~/pelias.json"
echo ""

echo "Step 5: Starting data import..."
echo "This may take a while. Output will be redirected to import-${DATASET}.log"
echo "You can monitor progress with: tail -f import-${DATASET}.log"
echo ""

START_TIME=$(date +%s)
npm start > "import-${DATASET}.log" 2>&1
IMPORT_EXIT_CODE=$?
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
ELAPSED_MINUTES=$((ELAPSED / 60))
ELAPSED_SECONDS=$((ELAPSED % 60))

if [ $IMPORT_EXIT_CODE -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "✓ Reindexing completed successfully!"
    echo "=========================================="
    
    DOC_COUNT=$(curl -s "${ELASTICSEARCH_HOST}/${INDEX_NAME}/_count" | python3 -c "import sys, json; print(json.load(sys.stdin)['count'])" 2>/dev/null || echo "unknown")
    echo "Total documents indexed: ${DOC_COUNT}"
    echo "Time taken: ${ELAPSED_MINUTES}m ${ELAPSED_SECONDS}s (${ELAPSED} seconds total)"
    
    if [ "$DOC_COUNT" != "unknown" ] && [ "$ELAPSED" -gt 0 ]; then
        RATE=$(echo "scale=0; $DOC_COUNT / $ELAPSED" | bc 2>/dev/null || echo "N/A")
        echo "Indexing rate: ${RATE} documents/second"
    fi
else
    echo ""
    echo "=========================================="
    echo "✗ Reindexing failed. Check import-${DATASET}.log for details."
    echo "=========================================="
    echo "Time taken before failure: ${ELAPSED_MINUTES}m ${ELAPSED_SECONDS}s (${ELAPSED} seconds total)"
    exit 1
fi
