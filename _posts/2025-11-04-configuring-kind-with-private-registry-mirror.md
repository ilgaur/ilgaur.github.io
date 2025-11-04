---
layout: post
title: "Configuring Kind with a Private Registry Mirror"
date: 2025-11-04 00:00:00 +0000
categories: technical-writeups
---

This document describes configuring Kind to use a private registry mirror when direct access to public registries is restricted.

## Problem Description

Kind clusters may encounter `403 Forbidden` errors when pulling images from `registry.k8s.io` due to network restrictions. Initial attempts using HTTP proxy configuration proved ineffective - containerd requires registry mirror configuration instead.

## Network Architecture

Kind nodes run as Docker containers in a bridge network with the following characteristics:

- `127.0.0.1` inside a Kind node refers to the container's loopback interface
- `172.18.0.1` (typical value) represents the Docker bridge gateway IP accessible from nodes
- Registry mirrors must be reachable via the bridge network interface

## Configuration Requirements

The configuration requires three components:

### 1. hosts.toml Configuration

Create a `hosts.toml` file without a `server` directive to enforce exclusive mirror usage:

```toml
# /etc/containerd/certs.d/registry.k8s.io/hosts.toml
# NO server line - this forces exclusive use of the mirror

[host."https://your-registry.example.com:8093"]
  capabilities = ["pull", "resolve"]
  skip_verify = true  # If using self-signed certificates
```

### 2. Containerd Authentication Configuration

Configure authentication via Kind's `containerdConfigPatches`:

```yaml
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
    
    [plugins."io.containerd.grpc.v1.cri".registry.configs."your-registry.example.com:8093".auth]
      username = "your-username"
      password = "your-password"
    
    [plugins."io.containerd.grpc.v1.cri".registry.configs."your-registry.example.com:8093".tls]
      insecure_skip_verify = true
```

### 3. Configuration Mount Points

Kind configuration with required mount paths:

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: ./registry-config/hosts.toml
        containerPath: /etc/containerd/certs.d/registry.k8s.io/hosts.toml
  - role: worker
    extraMounts:
      - hostPath: ./registry-config/hosts.toml
        containerPath: /etc/containerd/certs.d/registry.k8s.io/hosts.toml
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
    
    [plugins."io.containerd.grpc.v1.cri".registry.configs."your-registry.example.com:8093".auth]
      username = "${REGISTRY_USERNAME}"
      password = "${REGISTRY_PASSWORD}"
    
    [plugins."io.containerd.grpc.v1.cri".registry.configs."your-registry.example.com:8093".tls]
      insecure_skip_verify = true
```

## Implementation Script

Setup script for automated configuration:

```bash
#!/bin/bash

# Configuration
CLUSTER_NAME="my-cluster"
REGISTRY_URL="your-registry.example.com:8093"
REGISTRY_USERNAME="your-username"
REGISTRY_PASSWORD="your-password"

# Create directory structure
mkdir -p ./generated/registry-config

# Generate hosts.toml (no server line!)
cat > ./generated/registry-config/hosts.toml <<EOF
[host."https://${REGISTRY_URL}"]
  capabilities = ["pull", "resolve"]
  skip_verify = true
EOF

# Generate Kind configuration
cat > ./generated/kind-config.yaml <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: $(pwd)/generated/registry-config/hosts.toml
        containerPath: /etc/containerd/certs.d/registry.k8s.io/hosts.toml
  - role: worker
    extraMounts:
      - hostPath: $(pwd)/generated/registry-config/hosts.toml
        containerPath: /etc/containerd/certs.d/registry.k8s.io/hosts.toml
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
    
    [plugins."io.containerd.grpc.v1.cri".registry.configs."${REGISTRY_URL}".auth]
      username = "${REGISTRY_USERNAME}"
      password = "${REGISTRY_PASSWORD}"
    
    [plugins."io.containerd.grpc.v1.cri".registry.configs."${REGISTRY_URL}".tls]
      insecure_skip_verify = true
EOF

# Create the cluster
kind create cluster --name ${CLUSTER_NAME} --config ./generated/kind-config.yaml

# Wait for cluster to be ready
kubectl wait --for=condition=Ready nodes --all --timeout=60s

# Test with metrics-server
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Verify the deployment
kubectl get pods -n kube-system | grep metrics-server
```

## Verification

Verification methods:

1. **Examine pod events:**
```bash
kubectl describe pod -n kube-system metrics-server-<pod-id>
```

Pull timing observations:
- Initial pull: ~9 seconds (remote fetch via mirror)
- Subsequent pull: ~270ms (mirror cache hit)

2. **Inspect containerd state:**
```bash
docker exec kind-control-plane crictl images | grep metrics-server
```

3. **Query registry mirror:**

Registry API endpoint for cached tags:
```bash
curl -u username:password \
  "https://your-registry.example.com:8093/v2/metrics-server/metrics-server/tags/list"
```

## Technical Notes

### HTTP Proxy vs Registry Mirror

HTTP proxy configuration (`HTTP_PROXY`/`HTTPS_PROXY` environment variables) applies to general HTTP traffic. Containerd implements a separate registry configuration mechanism for image pulls.

### hosts.toml Behavior

Omitting the `server` directive in hosts.toml changes containerd's behavior. With the server directive present, containerd attempts upstream registry access first, falling back to mirrors on failure. Without it, containerd uses only the configured mirror.

**With server directive (fallback behavior):**
```toml
server = "https://registry.k8s.io"

[host."https://your-registry.example.com:8093"]
  capabilities = ["pull", "resolve"]
```

**Without server directive (exclusive mirror):**
```toml
[host."https://your-registry.example.com:8093"]
  capabilities = ["pull", "resolve"]
  skip_verify = true
```

### Configuration Components

Required elements:
1. Registry authentication via `containerdConfigPatches`
2. TLS verification skip for self-signed certificates (configured in hosts.toml and containerd config)
3. Correct mount paths for configuration files

## Performance Observations

Registry mirror usage results:
- Reduced bandwidth consumption through caching
- Cache hits approximately 30-40x faster than remote pulls
- Elimination of external registry dependencies
- Centralized image availability management

## Troubleshooting

Common issues and diagnostics:

1. **Verify hosts.toml configuration:** Confirm absence of server directive
2. **Authentication validation:** Verify credentials
3. **Network connectivity from Kind node:**
   ```bash
   docker exec -it kind-control-plane bash
   curl -k https://your-registry.example.com:8093/v2/
   ```
4. **Containerd configuration inspection:**
   ```bash
   docker exec kind-control-plane cat /etc/containerd/config.toml
   ```
5. **Containerd service logs:**
   ```bash
   docker exec kind-control-plane journalctl -u containerd
   ```

## Summary

Configuring Kind with a private registry mirror requires containerd registry configuration rather than HTTP proxy settings. The configuration consists of: hosts.toml without a server directive, authentication through containerdConfigPatches, and appropriate file mounts. This approach addresses network-restricted environments where direct registry access is unavailable.