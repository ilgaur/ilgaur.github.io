---
layout: post
title: "Replicating docker volumes: A Late-Night Hack"
date: 2025-05-17 12:06:00 +0000
categories: technical-writeups
---

So there I was at 2 AM, another cup of tea down, trying to get a Postgres database from one Docker container to another. Same server, should be easy right? Yeah, no.

Tried the whole `pg_dump` thing first. Faced some errors while importing the dump. The usual headache. And honestly? I was way too tired to debug the esoteric dump errors properly.

Was sitting hopeless the it hit me - why mess with dumps when I could just copy the entire Docker volume? I'm on the same VM, so this should be easy despite the ugly look of it.

Here's what I did:

1. First of all, checked what volumes I had:
```bash
docker volume ls
```

2. Created new volumes with my target names that matched the volumes from compose files which were run via GitLab pipelines:
```bash
docker volume create my-new-app_postgres-data
docker volume create my-new-app_static_data
```

3. The cool part - used a throwaway Alpine container to copy everything:
```bash
docker run --rm -v my-old-app_postgres-data:/from -v my-new-app_postgres-data:/to alpine ash -c "cd /from && cp -av . /to"
```

Did the same for the static data volume too.

That's it! Took like 5 minutes total. The original container kept running the whole time, and I got an exact clone of the database without any of the usual import/export headaches.