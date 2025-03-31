---
layout: post
title: "Achieving a Higher Degree of Deployment Modularity with Docker Compose Profiles"
date: 2025-03-31 02:23:00 +0000
categories: technical-writeups
---

# Achieving a Higher Degree of Deployment Modularity with Docker Compose Profiles

Have you ever found yourself juggling multiple versions of docker-compose files for different environments? I recently faced this challenge when working on a project many deployment environments. We were struggling with limited resources, sometimes needing to run dev and staging on the same server without conflicts.

This was the the time when I found an overlooked Docker compose feature, Compose profiles - a feature that turned out to be exactly what we needed. I will be demonstrating how this helped us create a cleaner, more modular approach to deployment.

## The Challenge: Too Many Docker Compose Files

If this sounds familiar, you're not alone:

- You start with a `docker-compose.yml` for local development
- Soon you add `docker-compose.dev.yml`, `docker-compose.staging.yml`, and `docker-compose.prod.yml`
- Before you know it, you're maintaining multiple similar files with slight differences
- Making a change means updating it in several places
- Someone forgets to update one file, and the debugging begins...

## A Better Way: Docker Compose Profiles

Profiles allow you to selectively enable services based on your environment or needs. Instead of multiple files, you can have a single compose file with services tagged for specific environments.

Here's how it works:
1. Assign profiles to services using the `profiles` attribute
2. Services without profiles are always started
3. Activate specific profiles when running Docker Compose commands

## A Simple Example

Let's look at a simplified example for a web application with a database:

```yaml
services:
  # Core application
  app:
    image: my-web-app:${APP_VERSION:-latest}
    container_name: ${ENV}-web-app
    ports:
      - "${APP_PORT}:3000"
    environment:
      - DB_HOST=db
      - DB_USER=${DB_USER}
      - DB_PASSWORD=${DB_PASSWORD}
    depends_on:
      - db
    profiles: ["dev", "staging", "prod"]

  # Database
  db:
    image: postgres:14
    container_name: ${ENV}-db
    environment:
      - POSTGRES_USER=${DB_USER}
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=${DB_NAME}
    volumes:
      - db-data:/var/lib/postgresql/data
    profiles: ["dev", "staging", "prod", "local"]

  # Database admin tool - only for development
  db-admin:
    image: dpage/pgadmin4:latest
    container_name: ${ENV}-db-admin
    environment:
      - PGADMIN_DEFAULT_EMAIL=${ADMIN_EMAIL}
      - PGADMIN_DEFAULT_PASSWORD=${ADMIN_PASSWORD}
    ports:
      - "${ADMIN_PORT}:80"
    depends_on:
      - db
    profiles: ["dev", "local"]

volumes:
  db-data:
```

For each environment, we create a simple `.env` file with the appropriate variables:

```
# .env.dev
ENV=dev
APP_VERSION=1.0.0
DB_USER=dev_user
DB_PASSWORD=dev_pass
DB_NAME=app_db
APP_PORT=5070
ADMIN_EMAIL=dev@example.com
ADMIN_PASSWORD=dev_pass
ADMIN_PORT=5050
```

## Using Profiles in Practice

Now we can deploy to different environments easily:

```bash
# For development
docker compose --profile dev --env-file .env.dev up -d

# For staging
docker compose --profile staging --env-file .env.staging up -d

# For production (no DB admin tool)
docker compose --profile prod --env-file .env.prod up -d

# For local development
docker compose --profile local --env-file .env.local up -d
```

Notice how the database admin tool only runs in development and local environments since it's only assigned to those profiles, also we have seperated a local profile for ease of use when developers need to run their compiled version of app using the utilities provided in their choice of IDE which means they won't need the app in the local compose stack they are bringing up.

## Why This Makes Life Easier

This approach has several benefits:

1. **One file to maintain** - No more copying changes between multiple files
2. **Environment-specific services** - Some tools only run in certain environments
3. **Flexible deployments** - Run multiple environments on one server when needed
4. **Clearer organization** - It's immediately obvious which services run where

## When to Try This Approach

Consider using Docker Compose profiles when:
- You deploy to multiple similar environments
- You want to avoid duplicating configuration
- You have optional services (like monitoring or admin tools)
- You need different combinations of services in different situations

## Final Thoughts

Compose profiles have simplified our deployment workflow considerably. No more juggling multiple compose files or struggling with environment-specific configurations.

If you're dealing with similar challenges, give profiles a try. For more details, check out the [official Docker documentation on profiles](https://docs.docker.com/compose/how-tos/profiles/).
