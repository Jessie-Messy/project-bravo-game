// Every listing photo, in the order the gallery shows them. `src` is the original in
// photos-src/; `npm run images` turns each into responsive WebP files under public/img.
// Alt text describes what is actually in the frame -- it is read aloud to screen reader
// users, so "Additional photos image 3" (the Airbnb caption) would tell them nothing.
export const PHOTOS = [
  { slug: 'sunset-drive', src: 'ca8f2e23-5f31-40cf-919c-cf068841d63d.jpeg', group: 'Grounds',
    alt: 'Pink and orange sunset over open green pastures, with the paved ranch drive running between fenced fields' },
  { slug: 'horses-pasture', src: 'c58f1629-a16d-4ad8-afc4-95c4ad00b1d5.jpeg', group: 'Grounds',
    alt: 'Two horses, one white and one buckskin, standing at a wire fence in a sunny pasture' },
  { slug: 'barn-stalls', src: 'e2e0d123-6bdc-473b-83ae-dc73b2147930.jpeg', group: 'Barn',
    alt: 'Inside the barn: a row of new pine horse stalls with black steel grille fronts and ceiling fans' },
  { slug: 'stall-row', src: '5d72e389-a34f-473f-9451-0c336cd91764.jpeg', group: 'Barn',
    alt: 'Stall row with tall pine walls, black steel bars and a fan mounted over each stall' },
  { slug: 'stall-open', src: '61b48896-cc9e-485e-8a8d-2846e84f04fa.jpeg', group: 'Barn',
    alt: 'An open stall door showing a clean, roomy pine-lined stall, with a muck fork and trash can nearby' },
  { slug: 'barn-aisle', src: 'afe8e5ae-9a10-4236-a5cb-d7e092ac9cbf.jpeg', group: 'Barn',
    alt: 'Wide concrete barn aisle seen from the roll-up door, with steel walls and a stall on the right' },
  { slug: 'tack-room', src: '53ab1db4-2aa1-4c3a-b542-d8cf1c6fa5bf.jpeg', group: 'Barn',
    alt: 'Barn tack room wall finished in stained wood planks, with a white door and the roll-up door open to the lot' },
  { slug: 'trailer-lot', src: '014ba77a-4113-42cb-a1fa-db243fa74bc0.jpeg', group: 'Grounds',
    alt: 'Large gravel lot for trucks, horse trailers and RVs under a clear blue sky, trees along the edge' },
  { slug: 'house-front', src: 'd29a1915-30d8-42ca-848d-b4d377e8fd82.jpeg', group: 'House',
    alt: 'Front of the single-level ranch house with white siding and front steps, set back from a gravel drive' },
  { slug: 'kitchen-island', src: '81ad1c85-9ff7-45d2-9216-f5065fb0d235.jpeg', group: 'House',
    alt: 'Bright kitchen with white cabinets, marble-look island, three bar stools and stainless range' },
  { slug: 'kitchen-hall', src: '4e70e273-6966-483c-a90b-ccbddf1e729f.jpeg', group: 'House',
    alt: 'Kitchen and entry hallway with a stainless refrigerator, tall pantry cabinets and wood-look floors' },
  { slug: 'coffee-bar', src: 'd349f07a-e412-40c2-b9cd-60e92b7cebf2.jpeg', group: 'House',
    alt: 'Coffee bar with floating shelves and a coffee maker beside the washer' },
  { slug: 'bedroom-1', src: '4bbd1e9c-d04b-466e-bc4d-60670ba6b7e2.jpeg', group: 'House',
    alt: 'Primary bedroom with a queen bed in green bedding, a wooden dresser and a wall-mounted TV' },
  { slug: 'bedroom-2', src: '54ed609a-1835-4c41-adbf-a45ab00fc842.jpeg', group: 'House',
    alt: 'Second bedroom with a blue plaid quilt, rustic nightstand and table lamp' },
  { slug: 'bedroom-3', src: 'b5cb643c-7d20-4cac-bc8e-8503c5da6a21.jpeg', group: 'House',
    alt: 'Third bedroom with a patterned grey and white comforter and a bedside lamp' },
  { slug: 'bath-1', src: '60f8be49-c580-4cd3-9666-9b33c3ad2ad9.jpeg', group: 'House',
    alt: 'Primary bathroom with a double-sink vanity, tiled wall and fresh flowers' },
  { slug: 'bath-2', src: 'fb6121da-2baf-4d7c-8ea4-04ba1bb95fff.jpeg', group: 'House',
    alt: 'Second bathroom with a red striped shower curtain, toilet and single-sink vanity' },
  { slug: 'laundry', src: '8c5934b0-f40e-45d5-b7e9-474178994521.jpeg', group: 'House',
    alt: 'Laundry nook with a front-loading washer, white cabinets and open shelves' },
];

export const IMAGE_WIDTHS = [480, 960, 1600];
