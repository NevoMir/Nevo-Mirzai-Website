-- The latest block analysis of a model (an AnalysisSummary as JSON), saved by the browser after it runs the
-- analysis so chat cards and the Models list can show a verdict without loading the GLB. It is derived data:
-- NULL until the first analysis, and always safe to overwrite.
ALTER TABLE models ADD COLUMN analysis TEXT;
