---
layout: post
title: "Getting Kubespray to Work Behind a Proxy: Lessons from a Bastion-Based Deployment"
date: 2025-10-06 10:00:00 +0000
categories: technical-writeups
---

# Getting Kubespray to Work Behind a Proxy: Lessons from a Bastion-Based Deployment

Setting up Kubernetes clusters with Kubespray in environments where sanctions or network restrictions block access to essential repositories can be challenging. In these situations, you typically need a proxy to reach container registries and package repositories that would otherwise be unreachable. After spending considerable time troubleshooting HTTP 403 errors and mysterious download failures, here's a practical guide based on deploying a multi-node cluster through a bastion host setup.

## The Architecture Pattern

In this deployment, we used a common pattern: HAProxy nodes serving dual duty as both load balancers and bastion hosts. The cluster consisted of 2 HAProxy nodes with a floating VIP, 3 control plane nodes, and 3 worker nodes.

All nodes sat behind a proxy for external access, with the proxy utility running on the bastion at `127.0.0.1:12334`. This is where things got interesting.

## The Core Problem

Kubespray needs to download dozens of artifacts - kubeadm, kubectl, container images, CNI plugins. When `download_localhost` is enabled (which is recommended to avoid redundant downloads), Kubespray tries to fetch everything on the bastion first, then distribute to nodes. But here's the catch: even with centralized downloads, nodes still need proxy access for their package managers.

Understanding what's actually failing is critical. When downloads fail, Kubespray hides the actual error by default. Use `unsafe_show_logs=true` when troubleshooting to see actual HTTP errors and URLs - this saved hours of blind debugging.

The initial failure looked like this:
```
"msg": "Request failed",
"response": "HTTP Error 403: Forbidden",
"url": "https://dl.k8s.io/release/v1.32.8/bin/linux/amd64/kubeadm"
```

## Understanding Kubespray's Proxy Variables

Kubespray actually has several proxy-related knobs, and understanding what each does is crucial:

- `http_proxy` / `https_proxy`: The proxy endpoints for downloads
- `download_localhost`: If true, downloads happen on the control host (bastion)
- `download_run_once`: Prevents re-downloading for each node
- `download_validate_certs`: Whether to verify SSL certificates
- `no_proxy`: Networks that should bypass the proxy
- `no_proxy_exclude_workers`: Special case for excluding worker nodes from no_proxy

## The Solution That Worked

### 1. Make the Proxy Network-Accessible

The first issue we hit: a proxy bound to localhost isn't reachable from cluster nodes. This is a common mistake - many proxy services default to listening only on 127.0.0.1 for security, but your nodes need network access to it. We configured ours to listen on all interfaces (0.0.0.0) so any node could reach it. Depending on your setup, you might bind to a specific private interface instead - the key is making sure your proxy is actually reachable from where it needs to be used. Network accessibility matters more than you'd think.

### 2. Configure Kubespray's Inventory Correctly

The key was getting all the proxy variables right in `inventory/group_vars/all/all.yml`. Pay special attention to the `no_proxy` list - it's critical to include all cluster CIDRs, service networks, and the `.svc.cluster.local` domain to avoid proxying internal cluster traffic:

```yaml
# Proxy endpoints - using the bastion's private VIP
http_proxy: "http://172.16.10.1:12334"
https_proxy: "http://172.16.10.1:12334"

# Critical: exclude internal networks from proxy
no_proxy: "localhost,127.0.0.1,172.16.10.0/24,10.96.0.0/12,10.244.0.0/16,.svc,.svc.cluster.local"

# Include node IPs in no_proxy automatically
additional_no_proxy: "172.16.10.10,172.16.10.11,172.16.10.12,172.16.10.20,172.16.10.21,172.16.10.22"

# Download settings for efficiency
download_localhost: true
download_run_once: true
download_validate_certs: true  # Set false if proxy uses self-signed certs
```

### 3. Prepare the Bastion for Container Downloads

With `download_localhost=true`, Kubespray tries to pull container images on the bastion using `nerdctl`. This fails if the bastion lacks container runtime tools. This is an important cascade effect to understand: choosing `download_localhost=true` means your bastion needs container runtime tools, not just Ansible.

```bash
# Install on bastion during provisioning
apt-get update && apt-get install -y containerd
curl -fsSL -o /tmp/nerdctl.tar.gz \
  https://github.com/containerd/nerdctl/releases/download/v2.0.5/nerdctl-2.0.5-linux-amd64.tar.gz
tar -C /usr/local/bin -xzf /tmp/nerdctl.tar.gz nerdctl
systemctl enable containerd && systemctl start containerd
```

### 4. Test Before Running Kubespray

Before attempting the full deployment, verify proxy connectivity from both the bastion and a sample node. This simple step can save hours of troubleshooting later:

```bash
# From bastion
curl -x 172.16.10.1:12334 https://dl.k8s.io

# From a worker node
ssh worker-1 'curl -x 172.16.10.1:12334 https://icanhazip.com'
```

## Debugging Failed Downloads

When downloads fail, Kubespray hides the actual error by default. To see what's really happening, run with the `unsafe_show_logs` flag:

```bash
# Run with unsafe_show_logs to see actual URLs and errors
ansible-playbook -i inventory/hosts.yml kubespray/cluster.yml \
  --become --tags download -vvv \
  -e '{"unsafe_show_logs": true}'
```

## Alternative Approach

If installing container tools on the bastion seems like overkill, you can flip the approach:

```yaml
download_localhost: false  # Downloads happen on first control plane node
download_run_once: true   # But still only download once
```

This way, the first control plane node (which already has containerd) handles all downloads and shares with other nodes.

With proper proxy configuration, Kubespray can efficiently deploy Kubernetes clusters even in restricted environments.
