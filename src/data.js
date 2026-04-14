'use strict';

/**
 * In-memory sample data for the epb_test_js demo app.
 *
 * Facilities represent school buildings.
 * Computers and projectors each belong to a facility.
 */

const FACILITIES = [
  { id: 1, name: 'Lincoln Elementary',    city: 'Springfield' },
  { id: 2, name: 'Westview Middle School', city: 'Shelbyville' },
  { id: 3, name: 'Riverside High School',  city: 'Capital City' },
];

const COMPUTERS = [
  { id: 1, facility_id: 1, make: 'Dell',    model: 'Chromebook 3100',  location: 'Room 101' },
  { id: 2, facility_id: 1, make: 'HP',      model: 'Desktop 400 G9',   location: 'Room 102' },
  { id: 3, facility_id: 1, make: 'Apple',   model: 'iPad (10th gen)',   location: 'Library' },
  { id: 4, facility_id: 2, make: 'Apple',   model: 'MacBook Air M2',    location: 'Computer Lab' },
  { id: 5, facility_id: 2, make: 'Lenovo',  model: 'ThinkPad E14',     location: 'Room 201' },
  { id: 6, facility_id: 2, make: 'Microsoft', model: 'Surface Pro 9',  location: 'Room 201' },
  { id: 7, facility_id: 3, make: 'Lenovo',  model: 'IdeaPad 3',        location: 'Room 301' },
  { id: 8, facility_id: 3, make: 'Apple',   model: 'iMac 24"',         location: 'Media Room' },
];

const PROJECTORS = [
  { id: 1, facility_id: 1, make: 'Epson',    model: 'PowerLite 118',   location: 'Room 101' },
  { id: 2, facility_id: 1, make: 'BenQ',     model: 'MX808STH',        location: 'Room 102' },
  { id: 3, facility_id: 2, make: 'Samsung',  model: 'Smart TV 65"',    location: 'Room 201' },
  { id: 4, facility_id: 2, make: 'Panasonic', model: 'PT-VMZ60',       location: 'Auditorium' },
  { id: 5, facility_id: 3, make: 'Epson',    model: 'EB-FH52',         location: 'Room 301' },
  { id: 6, facility_id: 3, make: 'LG',       model: '4K UHD Display',  location: 'Media Room' },
];

/** Returns a facility by id, or undefined. */
function getFacility(id) {
  return FACILITIES.find(f => f.id === id);
}

/** Returns projectors grouped by facility. */
function projectorsByFacility() {
  return FACILITIES.map(facility => ({
    facility,
    projectors: PROJECTORS.filter(p => p.facility_id === facility.id),
  }));
}

module.exports = { FACILITIES, COMPUTERS, PROJECTORS, getFacility, projectorsByFacility };
