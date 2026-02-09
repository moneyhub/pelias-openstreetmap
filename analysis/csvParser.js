const fs = require('fs');

function parseCSVLine(line) {
  const fields = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i += 2;
      } else if (inQuotes && nextChar === ',') {
        inQuotes = false;
        i++;
      } else {
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(currentField.trim());
      currentField = '';
      i++;
    } else {
      currentField += char;
      i++;
    }
  }
  
  fields.push(currentField.trim());
  return fields;
}

function parseCSV(filePath, debug = false, filterRegion = '') {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  
  if (debug) {
    console.log(`\n[DEBUG] CSV File: ${filePath}`);
    console.log(`[DEBUG] Total lines in file: ${lines.length}`);
    console.log(`[DEBUG] First line (raw): ${lines[0].substring(0, 200)}...`);
  }
  
  const headerFields = parseCSVLine(lines[0]);
  const headers = headerFields.map(h => {
    if (h.startsWith('"') && h.endsWith('"')) {
      return h.slice(1, -1).replace(/""/g, '"');
    }
    return h;
  });
  
  if (debug) {
    console.log(`[DEBUG] Parsed headers (${headers.length} columns):`);
    headers.forEach((h, idx) => {
      if (idx < 10 || idx >= headers.length - 5) {
        console.log(`  [${idx}] "${h}"`);
      } else if (idx === 10) {
        console.log(`  ... (${headers.length - 15} more columns) ...`);
      }
    });
  }
  
  const latIdx = headers.indexOf('latitude');
  const lonIdx = headers.indexOf('longitude');
  const postcodeIdx = headers.indexOf('ground_truth_postcode');
  let regionIdx = -1;
  if (filterRegion) {
    regionIdx = headers.indexOf('geotag_region');
    if (regionIdx === -1) {
      regionIdx = headers.indexOf('region');
    }
  }
  
  if (debug) {
    console.log(`\n[DEBUG] Column indices:`);
    console.log(`  latitude: ${latIdx}`);
    console.log(`  longitude: ${lonIdx}`);
    console.log(`  ground_truth_postcode: ${postcodeIdx}`);
    if (filterRegion) {
      console.log(`  region column: ${regionIdx !== -1 ? (headers[regionIdx] || 'unknown') : 'not found'}`);
      if (regionIdx === -1) {
        console.log(`  WARNING: 'geotag_region' or 'region' column not found, filter will be ignored`);
      }
    }
  }
  
  if (latIdx === -1 || lonIdx === -1 || postcodeIdx === -1) {
    throw new Error('CSV must contain columns: latitude, longitude, ground_truth_postcode');
  }
  
  if (filterRegion && regionIdx === -1) {
    console.warn(`WARNING: 'geotag_region' or 'region' column not found in CSV. Filter '${filterRegion}' will be ignored.`);
  }

  const records = [];
  let skippedInvalid = 0;
  let skippedEmpty = 0;
  let skippedNaN = 0;
  let skippedRegion = 0;
  
  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    
    try {
      const fields = parseCSVLine(rawLine);
      const values = fields.map(f => {
        if (f.startsWith('"') && f.endsWith('"')) {
          return f.slice(1, -1).replace(/""/g, '"');
        }
        return f;
      });
      
      if (values.length !== headers.length) {
        skippedInvalid++;
        if (debug && skippedInvalid <= 3) {
          console.log(`[DEBUG] Skipped row ${i + 1}: column count mismatch (expected ${headers.length}, got ${values.length})`);
        }
        continue;
      }
      
      if (filterRegion && regionIdx !== -1) {
        const regionValue = values[regionIdx] || '';
        const regionLower = regionValue.toLowerCase().trim();
        const filterLower = filterRegion.toLowerCase().trim();
        if (!regionLower.includes(filterLower)) {
          skippedRegion++;
          if (debug && skippedRegion <= 3) {
            console.log(`[DEBUG] Skipped row ${i + 1}: region mismatch (got "${regionValue}", filter: "${filterRegion}")`);
          }
          continue;
        }
      }
      
      const latStr = values[latIdx];
      const lonStr = values[lonIdx];
      const postcode = values[postcodeIdx];
      
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      
      if (isNaN(lat) || isNaN(lon)) {
        skippedNaN++;
        if (debug && skippedNaN <= 3) {
          console.log(`[DEBUG] Skipped row ${i + 1}: invalid lat/lon (lat="${latStr}", lon="${lonStr}")`);
        }
        continue;
      }
      
      if (!postcode || postcode.trim() === '') {
        skippedEmpty++;
        if (debug && skippedEmpty <= 3) {
          console.log(`[DEBUG] Skipped row ${i + 1}: empty postcode`);
        }
        continue;
      }
      
      records.push({
        latitude: lat,
        longitude: lon,
        ground_truth_postcode: postcode
      });
      
      if (debug && records.length <= 3) {
        console.log(`[DEBUG] Parsed record ${records.length}: lat=${lat}, lon=${lon}, postcode="${postcode}"`);
      }
    } catch (error) {
      skippedInvalid++;
      if (debug && skippedInvalid <= 3) {
        console.log(`[DEBUG] Skipped row ${i + 1}: parsing error - ${error.message}`);
      }
    }
  }

  if (debug) {
    console.log(`\n[DEBUG] Parsing summary:`);
    console.log(`  Valid records: ${records.length}`);
    console.log(`  Skipped (column mismatch): ${skippedInvalid}`);
    if (filterRegion) {
      console.log(`  Skipped (region filter): ${skippedRegion}`);
    }
    console.log(`  Skipped (invalid lat/lon): ${skippedNaN}`);
    console.log(`  Skipped (empty postcode): ${skippedEmpty}`);
    if (records.length > 0) {
      console.log(`\n[DEBUG] First valid record:`, records[0]);
    }
  }

  return records;
}

module.exports = { parseCSV };
