<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# waferlock

This repository is part of the Joyent Triton and Manta projects.
For contribution guidelines, issues, and general documentation, visit the main
[Triton](http://github.com/joyent/triton) and
[Manta](http://github.com/joyent/manta) project pages.


Waferlock is a node.js process that runs inside a Triton or Manta
[manatee](https://github.com/joyent/manatee/) zone ("manatee" service instances
in Triton, "postgres" and "buckets-postgres" service instances in Manta) to
limit access to the running postgres to those IPs explicitly allowed access.

The mechanism for access control is PostgreSQL's
[pg_hba.conf](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html)
file. (HBA stands for host-based authentication.) Waferlock updates
"/manatee/pg/data/pg_hba.conf" with the set of allowed IPs and HUPs postgres
when that changes. The set of IPs to allow are monitored (via polling) from two
sources:

1. Waferlock polls SAPI for current instances of configured service names
   (`sapi_services` config var in the [config
   template](./sapi_manifests/waferlock/template)).
2. Waferlock polls ZK for domain nodes of configured domain names (`domains`
   config var in the [config template](./sapi_manifests/waferlock/template)).


The written config file is a [base config file](./etc/pg_hba.conf) plus
waferlock-added sections of the form:

    # <tags>
    host all all <ip> trust
    host replication all <ip> trust

where `<tags>` indicates what SAPI and/or ZK record the IP is from and `<ip>` is
an IPv4 address (in CIDR format, per the PostgreSQL docs). For example:

    # sapi:manta:buckets-postgres:eacbcaba-8b5b-4250-967a-8d2cbb7eccba, zk:/us/joyent/nightly/buckets-mdapi/2/eacbcaba-8b5b-4250-967a-8d2cbb7eccba
    host  all  all  172.27.2.24/32  trust
    host  replication  all  172.27.2.24/32  trust
