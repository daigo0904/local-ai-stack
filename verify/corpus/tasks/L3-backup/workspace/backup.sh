#!/bin/sh
pg_dump "$DATABASE_URL" > dump.sql && aws s3 cp dump.sql s3://backups/
