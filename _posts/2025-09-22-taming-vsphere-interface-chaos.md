---
layout: post
title: "Taming vSphere Interface Chaos: Deterministic MACs + Netplan Match Rules"
date: 2025-09-22 12:06:00 +0000
categories: technical-writeups
---

When you run a mixed OpenStack stack (controllers, computes, Ceph OSDs, Neutron nodes, a deployer bastion) on VMware vSphere, every VM type tends to expose a different number of NICs. Unless you act, Linux will label those NICs purely by PCIe discovery order (the sequence in which the kernel detects PCI devices during boot) so ens33 on one VM may be the storage back‐end while ens33 on another is the external API. this leads to expecting an automation that ensures: "storage is always ens36, or API is always ens40"

Below is my recipe to achieve *identical interface names on every VM*, regardless of how many networks each VM attaches to.

To understand why this chaos happens, we need to first look at how modern Linux names network interfaces. The kernel assigns names following this priority:

1. Custom udev rules (if present)
2. Firmware/BIOS index numbers (eno*)
3. PCI Express hotplug slot indices (ens*)
4. Physical/geographical location (enps)
5. Traditional unpredictable naming (eth*)

In virtualized environments like vSphere, interfaces typically follow the `ens*` pattern based on their PCIe slot order. The catch? Since different VM types have different numbers of network adapters, the same logical network ends up in different PCIe slots across VMs, resulting in different interface names.

## The problem  

Environment:
- Ubuntu 24.04 templates cloned by Terraform vSphere provider 2.12.0.  
- Port groups:  
  A = External (172.17.1.0/24)  
  B = Management (172.17.10.0/24)  
  C = Tenant (172.17.20.0/24)  
  D = Provider (172.17.70.0/24)  
  E = Storage (172.17.150.0/24)  

Symptoms:
1. Controllers (A + B + D + E) and Ceph nodes (A + E) both boot with `ens33`, `ens34`, … but the label-to-network mapping changes every time vSphere decides to shuffle PCI slots.  
2. On a compute node the storage back-end might be `ens36`; on a Ceph OSD the same /24 shows up as `ens33`.  
3. Ansible playbooks and cloud-init templates that relied on the interface schemas being consistent in their setup and naming would then fail.


## Why it happens  

1. **MAC assignment in vSphere**  
   -  When you omit a MAC address, ESXi allocates one from 00:50:56:xx:yy:zz (VMware’s OUI) but with *random* lower 3 bytes per vNIC.  
   -  PCI devices are added to the VM in the order the template stored them. Clones that add/remove NICs shift that order.

2. **Predictable Network Interface Names (PNIN)** in modern systemd  
   -  Ubuntu follows `ens<slot>` where *slot* is the PCI function number, not the vNIC index you configured. Different NIC counts ⇒ different slot numbers.  
   -  Result: identical port groups receive different `ens*` names between VM classes.

### Understanding vSphere MAC Address Assignment

A common point of confusion: why do VMs connected to the same network have different MAC addresses? Each VM requires unique MAC addresses even when sharing the same port group because:

**Each vNIC is a separate network endpoint.** Just like physical computers on the same switch need unique MAC addresses, virtual machines need distinct Layer 2 identities for proper Ethernet switching. The vSphere virtual switch maintains a MAC address table and makes forwarding decisions based on these unique identifiers.

**vCenter generates MACs per VM, not per network.** Our deterministic MAC generation follows this pattern—we derive unique MACs from each VM's IP address, ensuring no two VMs share a MAC while maintaining predictability. The same logical network (e.g., storage at 172.17.150.0/24) will have different MACs across VMs (.140 gets `00:50:56:11:9c:6c`, .146 gets `00:50:56:11:9c:32`) but always lands on the same interface name (`ens36`).

This design prevents MAC flapping, ARP conflicts, and packet forwarding errors that would occur with duplicate addresses.

## The solution at a glance  

```
Terraform (vSphere provider)
└─ usestaticmac = true
   │
   ├─ deterministic MAC = "00:50:56:" + hex(octet2, octet3, octet4)
   │
   └─ pass MAC → cloud-init netplan
       netplan:
         match:
           macaddress: XX:XX:XX:XX:XX:XX
         set-name: ens3X
```

1. Force vSphere to *honor* whatever MAC we hand it.  
2. Generate that MAC algorithmically from the VM’s IP so the same network always yields the same MAC.  
3. Tell netplan: “When you see this MAC, rename the link to ens33 (external), ens34 (mgmt)…”  

The net effect is that every Ubuntu guest, whether it has two NICs or five, exposes **identical interface names**.

## Implementation  

### 1 - Enable `use_static_mac` in Terraform  

```hcl
network_interface {
  network_id   = each.value
  mac_address  = local.mac_addresses[each.key]
  use_static_mac = true  # crucial – without this ESXi ignores our MAC
}
```

Without that flag ESXi silently overrides the `mac_address` you specify.

### 2 - Craft deterministic MACs  

VMware reserves 00:50:56:00:00:00–00:50:56:3F:FF:FF for manual assignment. Anything ≥0x40 in the 4th byte triggers vCenter’s “out of range” error.

Our convention:

```terraform
# ip = 172.17.150.146 → octets[1]=17, [2]=150, [3]=146
mac = format("00:50:56:%02x:%02x:%02x",
             octets[1], octets[2], octets[3])
# → 00:50:56:11:96:92
```
Rules:  
- Always fix the first three bytes to VMware’s OUI.  
- Derive the lower three bytes from the IP so they are unique per address yet deterministic.  
- For NICs that carry no IP (e.g., Neutron external), hash the VLAN ID instead.

### 3 - Render netplan with `match`/`set-name`  

Example for a compute node (`50-cloud-init.yaml` fragment):

```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    # External
    ens33:
      match:
        macaddress: 00:50:56:11:01:32
      set-name: ens33
      addresses: [172.17.1.146/24]
      routes:
        - to: default
          via: 172.17.1.1
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]

    # Management
    ens34:
      match:
        macaddress: 00:50:56:11:0a:32
      set-name: ens34
      addresses: [172.17.10.146/24]

    # Tenant
    ens35:
      match:
        macaddress: 00:50:56:11:14:32
      set-name: ens35
      addresses: [172.17.20.146/24]

    # Storage
    ens36:
      match:
        macaddress: 00:50:56:11:9c:32
      set-name: ens36
      addresses: [172.17.150.146/24]

    # Provider / Neutron external (no IP)
    ens37:
      match:
        macaddress: 00:50:56:11:46:00
      set-name: ens37
      dhcp4: no
```

Netplan evaluates `match` before kernel naming, applies `set-name`, and the result survives reboots and kernel upgrades.

### 4 - Templating

We embedded the logic in a reusable Terraform module:

```hcl
locals {
  mac_addresses = {
    for ip_key, ip in var.ip_addresses :
    ip_key => format("00:50:56:%02x:%02x:%02x",
                     tonumber(split(".", ip)[1]),
                     tonumber(split(".", ip)[2]),
                     tonumber(split(".", ip)[3]))
  }
}

data "template_file" "netplan" {
  template = file("${path.module}/templates/${var.vm_type}-netplan.tpl")
  vars = {
    ip_addresses = var.ip_addresses
    mac_addresses = local.mac_addresses
  }
}
```

Each VM type ships its own netplan template so we can omit sections for networks it doesn't use.

## The transformation in action

### Scenario: Storage network should always be accessible via `ens36`

**Before:**
```
Controller VM (4 NICs):
├─ ens33 → External (172.17.1.x)
├─ ens34 → Management (172.17.10.x)  
├─ ens35 → Provider (172.17.70.x)
└─ ens36 → Storage (172.17.150.x) ✓

Ceph OSD VM (2 NICs):
├─ ens33 → External (172.17.1.x)
└─ ens34 → Storage (172.17.150.x) ✗ Wrong interface!

Compute VM (5 NICs):
├─ ens33 → External (172.17.1.x)
├─ ens34 → Management (172.17.10.x)
├─ ens35 → Tenant (172.17.20.x)
├─ ens36 → Provider (172.17.70.x)
└─ ens37 → Storage (172.17.150.x) ✗ Wrong interface!
```

**After (deterministic naming):**
```
Controller VM (.143):
├─ ens33 → External (172.17.1.143)     [MAC: 00:50:56:11:01:8f]
├─ ens34 → Management (172.17.10.143)  [MAC: 00:50:56:11:0a:8f]
├─ ens36 → Storage (172.17.150.143)    [MAC: 00:50:56:11:9c:8f] ✓
└─ ens37 → Provider (no IP)            [MAC: 00:50:56:11:46:00]

Ceph OSD VM (.140):
├─ ens33 → External (172.17.1.140)     [MAC: 00:50:56:11:01:8c]
└─ ens36 → Storage (172.17.150.140)    [MAC: 00:50:56:11:9c:6c] ✓

Compute VM (.146):
├─ ens33 → External (172.17.1.146)     [MAC: 00:50:56:11:01:32]
├─ ens34 → Management (172.17.10.146)  [MAC: 00:50:56:11:0a:32]
├─ ens35 → Tenant (172.17.20.146)      [MAC: 00:50:56:11:14:32]
├─ ens36 → Storage (172.17.150.146)    [MAC: 00:50:56:11:9c:32] ✓
└─ ens37 → Provider (no IP)            [MAC: 00:50:56:11:46:00]

Network VM (.149):
├─ ens33 → External (172.17.1.149)     [MAC: 00:50:56:11:01:95]
├─ ens34 → Management (172.17.10.149)  [MAC: 00:50:56:11:0a:95]
├─ ens35 → Tenant (172.17.20.149)      [MAC: 00:50:56:11:14:95]
└─ ens37 → Provider (no IP)            [MAC: 00:50:56:11:46:00]
```

Notice how:
- **Storage network (172.17.150.x)** is always on `ens36` regardless of VM type
- **Each VM gets unique MACs** derived from its individual IP address (last octet: 8f, 8c, 32, 95)
- **Networks without IPs** (Provider) share the same MAC across VMs since they use VLAN-based hashing
- **Interface names are consistent** across all VM types for the same logical networks

Now Ansible playbooks or any other automation tools can safely reference `ens36` for example for storage across all VM types.

## Results  

After implementing this approach:

- All automation tools can now reliably reference `ens36` for storage across all VM types.  
- Interface names stay consistent through reboots, vMotion migrations, and template rebuilds.  
- Adding new NICs later is straightforward, just add another `match/set-name` rule to the netplan configuration template.