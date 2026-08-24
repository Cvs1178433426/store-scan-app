# Customer Catalog Import Architecture

## Objective

Store Scan must be able to onboard a retailer, wholesaler, distributor, warehouse operator, or inventory service using the customer's existing item master instead of forcing them to rebuild product data manually.

The onboarding target is:

**customer source data -> field mapping -> validation -> preview -> controlled import -> Product catalog -> Store Count immediately uses that catalog**

This is a commercial requirement, not an optional convenience. A new customer may already have tens of thousands or millions of SKUs in a POS, ERP, WMS, accounting package, SQL database, spreadsheet export, or custom item file.

## Supported source classes

The import system should be connector-neutral. Phase 1 should support file-based onboarding; later phases can add direct database/API synchronization without changing the Product domain.

### Phase 1 — files

- CSV / delimited text
- Microsoft Excel (.xlsx)
- JSON
- Customer-generated extracts from POS / ERP / WMS systems

### Phase 2 — database and API connectors

- PostgreSQL
- MySQL / MariaDB
- Microsoft SQL Server
- Oracle where commercially justified
- SFTP-delivered scheduled files
- REST APIs
- Vendor-specific connectors for common POS / ERP / WMS platforms

Direct database access must be read-only and credentialed per customer. Store Scan should never require write access to a customer's operational database for catalog onboarding.

## Canonical Store Scan Product model

Every source maps into one internal canonical representation. Customer column names must never leak into the Store Count engine.

Recommended canonical fields:

- customer/organization identifier
- external product key / SKU
- primary barcode (UPC/EAN/GTIN)
- additional barcodes / aliases
- product name / description
- manufacturer / brand
- package size / unit of measure
- category / department / class / subclass
- customer item number
- vendor item number
- case pack
- active/inactive status
- optional cost
- optional retail/selling price
- optional tax/status metadata
- optional image URL
- source-system identifier
- source updated timestamp

Not every customer will supply every field. Barcode, external key, and name rules should be configurable by onboarding profile.

## Import workflow

### 1. Select customer and source

An administrator chooses the Organization and either uploads a file or selects a configured source connection.

### 2. Detect structure

For files, detect:

- delimiter
- encoding
- header row
- worksheet (Excel)
- likely barcode / SKU / description columns
- duplicate columns
- obvious malformed rows

Never modify production data at this stage.

### 3. Field mapping

Show source columns on the left and Store Scan fields on the right.

Example:

| Customer column | Store Scan field |
| --- | --- |
| ITEM_NO | externalProductKey |
| UPC_CODE | barcodeValue |
| ITEM_DESC | name |
| DEPT | category |
| PACK | packageSize |
| ACTIVE_FLG | isActive |

Mappings must be saveable as an **Import Profile** so recurring imports from the same customer do not require remapping.

### 4. Transform rules

Profiles may define safe transforms such as:

- trim whitespace
- strip barcode spaces/dashes
- preserve leading zeros
- convert scientific-notation spreadsheet barcodes safely
- normalize booleans
- combine description fields
- derive package size
- map department codes to Store Scan categories
- map source active flags

Barcode handling is critical: UPC/EAN/GTIN values are identifiers, not numbers. They must be stored and processed as strings so leading zeros are never lost.

### 5. Validation and preview

Before committing anything, produce a preview with counts for:

- total rows
- valid rows
- new products
- updates to existing products
- unchanged products
- duplicates within the source
- barcode collisions
- missing required keys
- invalid/malformed rows
- products that would become inactive

Show representative samples and downloadable error details.

### 6. Controlled import transaction

The import should process in bounded batches and record an ImportRun.

Each imported row should have a deterministic matching policy, preferably:

1. organization + external product key when configured and present
2. otherwise organization + barcode
3. never match across organizations

Do not silently merge ambiguous products.

### 7. Reconciliation report

Every run must retain:

- who initiated it
- organization
- source/import profile
- source filename or connection
- start/end time
- row totals
- inserted/updated/unchanged/rejected counts
- errors
- import run identifier

A manager should be able to answer, "What changed when we loaded the customer's item file?"

## Full-load versus incremental synchronization

Customers will have different feed styles.

### Full replacement/catalog snapshot

A file may represent the customer's entire current item master. The import profile can optionally mark products absent from the new snapshot as inactive, but this must be an explicit profile setting with a preview of the effect.

Historical Store Count records must never be deleted when a Product becomes inactive.

### Incremental/delta feed

A feed may contain only changed products. In that case, absence means nothing and must never deactivate existing products.

The profile must declare whether a feed is FULL_SNAPSHOT or DELTA.

## Multi-tenant requirements

Before this is production-ready for multiple commercial customers:

- Product uniqueness must be organization-scoped, not global.
- ImportProfile belongs to one Organization.
- ImportRun belongs to one Organization and ImportProfile.
- Source credentials belong to one Organization and must be encrypted/secrets-managed.
- All read/write queries must be tenant-scoped.
- Automated tests must prove Organization A cannot import over, lookup, count, or export Organization B products.

The same UPC can legitimately exist in two customers' catalogs with different naming, SKU, category, package metadata, pricing, or active status.

## Proposed domain objects

### ImportProfile

- id
- organizationId
- name
- sourceType (CSV, XLSX, JSON, POSTGRES, MYSQL, MSSQL, API, SFTP...)
- feedMode (FULL_SNAPSHOT, DELTA)
- fieldMapping JSON
- transformRules JSON
- matchPolicy
- deactivationPolicy
- createdById
- createdAt / updatedAt

### ImportRun

- id
- organizationId
- importProfileId
- status (VALIDATING, READY, IMPORTING, COMPLETED, COMPLETED_WITH_ERRORS, FAILED)
- originalFileName / sourceReference
- sourceChecksum where applicable
- totalRows
- insertedRows
- updatedRows
- unchangedRows
- rejectedRows
- startedById
- startedAt / completedAt

### ImportRowError

- id
- importRunId
- sourceRowNumber
- externalProductKey
- barcodeValue
- errorCode
- errorMessage
- rawRow or safe subset

## Duplicate and collision rules

The system must distinguish:

1. Same record repeated in the same upload — deduplicate or reject deterministically.
2. Same external product key with changed product details — update according to profile policy.
3. Same barcode on two source products — flag collision for review unless the customer explicitly supports barcode aliases/pack levels.
4. Existing Store Scan Product with matching barcode but different external key — do not silently merge; preview as a collision.
5. Same barcode in different organizations — allowed after tenant scoping.

## Large catalog requirements

Do not design imports around small demo files.

Target architecture should support at least hundreds of thousands of products per organization and should be capable of scaling beyond that through batching/background jobs.

Requirements:

- streaming parser for large CSV files
- bounded memory use
- batched database writes
- progress reporting
- resumable/retryable background import where feasible
- database indexes for organization + barcode and organization + external key
- no HTTP request held open for a multi-minute import

## Security

- Upload size limits and file type validation
- Never execute macros from Excel workbooks
- Treat all imported text as untrusted
- Formula-injection-safe CSV exports
- Read-only direct database credentials
- Secrets never stored in plaintext configuration fields
- Audit every import
- Tenant-scoped access enforcement on preview, commit, history, and errors

## Product lookup interaction

The customer's item master is authoritative for customer-specific data.

Lookup providers (Open Food Facts, UPCItemDB, etc.) should be enrichment/fallback sources, not allowed to overwrite customer-owned fields automatically.

Recommended source precedence:

1. customer catalog/imported data
2. customer-approved manual edits
3. external provider enrichment for missing fields only

Every field that can be enriched should eventually retain provenance so support can explain where the value came from.

## Store Count acceptance test

The import feature is not complete until CI proves the real end-to-end path:

1. create Organization/customer context
2. upload/import representative item file
3. map customer columns
4. commit import
5. Product exists in the customer's catalog
6. start Store Count for that customer/site
7. scan imported barcode through the real HTTP scan route
8. count entry resolves the imported Product
9. summary displays customer product information
10. another organization cannot see or scan against that customer's catalog

Tests must also cover leading-zero barcodes and duplicate/collision behavior.

## Onboarding UX goal

A sales/support person should be able to tell a prospective customer:

> Send us your current item master or give us a read-only feed. We map it once, preview exactly what will change, load it into your Store Scan catalog, and your employees can start scanning your own merchandise.

That capability is central to making Store Scan adaptable to grocery, pharmacy, beauty, general merchandise, hardware, apparel, wholesale distribution, warehouse operations, and other barcode-based businesses without writing customer-specific versions of the application.
