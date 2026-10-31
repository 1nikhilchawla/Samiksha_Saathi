/** The block roster: BEO, DEO, one CRCC per cluster, and the HMs of flagged schools. */
import type { Person, SchoolRow } from "./model";

const CRCC_NAMES: [string, string][] = [
  ["Shri Anil Jain", "श्री अनिल जैन"],
  ["Smt. Rekha Namdev", "श्रीमती रेखा नामदेव"],
  ["Shri Farooq Khan", "श्री फारूक खान"],
  ["Shri Rajesh Verma", "श्री राजेश वर्मा"],
  ["Smt. Pooja Thakur", "श्रीमती पूजा ठाकुर"],
  ["Shri Imran Qureshi", "श्री इमरान कुरैशी"],
  ["Shri Santosh Patel", "श्री संतोष पटेल"],
  ["Smt. Kavita Soni", "श्रीमती कविता सोनी"],
];

export function buildPeople(schools: SchoolRow[]): Person[] {
  const people: Person[] = [
    { id: "beo", role: "BEO", nameEn: "Smt. Meera Tiwari", nameHi: "श्रीमती मीरा तिवारी", scope: "Kesli block", cluster: null },
    { id: "deo", role: "DEO", nameEn: "Shri R.S. Chouhan", nameHi: "श्री आर. एस. चौहान", scope: "District", cluster: null },
  ];
  for (let c = 1; c <= 8; c++) {
    const nm = CRCC_NAMES[c - 1]!;
    people.push({
      id: `crcc-${c}`,
      role: "CRCC",
      nameEn: nm[0],
      nameHi: nm[1],
      scope: `Cluster C${c}`,
      cluster: `C${c}`,
    });
  }
  const hmNames: Record<string, [string, string]> = {
    khedi: ["Shri Dinesh Lodhi", "श्री दिनेश लोधी"],
    harangaon: ["Smt. Sunita Rajak", "श्रीमती सुनीता रजक"],
    single: ["Shri Ramesh Ahirwar", "श्री रमेश अहिरवार"],
  };
  for (const s of schools) {
    if (s.kind === "khedi" || s.kind === "harangaon" || s.kind === "single") {
      const preset = s.kind === "single" ? null : hmNames[s.kind];
      const name = preset ?? (s.nameEn.includes("Sitapur")
        ? (["Shri Prakash Yadav", "श्री प्रकाश यादव"] as [string, string])
        : s.nameEn.includes("Berkhadi")
          ? (["Smt. Geeta Vishwakarma", "श्रीमती गीता विश्वकर्मा"] as [string, string])
          : hmNames.single!);
      people.push({
        id: `hm-${s.code}`,
        role: "HM",
        nameEn: name[0],
        nameHi: name[1],
        scope: s.nameEn,
        cluster: s.cluster,
      });
    }
  }
  return people;
}
