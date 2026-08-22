// Builds the shop map from the shelf photos: ten bays in walking order,
// starting at the croissants and finishing at the second fridge.
// Usage: node scripts/seed-shop-map.mjs            (writes .local/store-state.json)
//        node scripts/seed-shop-map.mjs --print    (prints the layout, writes nothing)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const sec = (name) => ({ id: randomUUID(), name });
// A shelf: one strip of the bay, cut across into named segments.
const shelf = (...names) => ({ id: randomUUID(), sections: names.map(sec) });

// Each bay lists its shelves top to bottom, and each shelf its segments left to
// right, taken from the price strips on the real shelf edges.
const bays = [
  {
    name: "Bakery & biscuits", kind: "shelving", tall: 7, w: 6,
    shelves: [
      shelf("Multipack crisps"),
      shelf("Warburtons bread"),
      shelf("Cakes (as priced)", "Protein bars"),
      shelf("Croissants", "Tea cakes", "Pies", "Snowballs"),
      shelf("Biscuit bars", "Snickers / KitKat"),
      shelf("Ginger nuts", "Jaffa cakes", "Digestives", "Rich Tea"),
    ],
  },
  {
    name: "Sweets & chocolate", kind: "shelving", tall: 7, w: 6,
    shelves: [
      shelf("Bags of sweets"),
      shelf("Chocolate blocks", "Freddo", "Eclairs / Fox's", "Protein bars"),
      shelf("Sweets (baskets)"),
      shelf("Chocolate bars (baskets)", "Bueno"),
      shelf("Tea biscuits", "Robinsons", "Vimto", "Fizzy 2L"),
    ],
  },
  {
    name: "Tins & soup", kind: "shelving", tall: 7, w: 7,
    shelves: [
      shelf("Heinz soup", "Cup a Soup"),
      shelf("Hot dogs", "Chilli", "Chicken / white sauce", "Chicken curry", "Mince & onion", "Stewed steak", "Tuna", "Paste", "Sardines", "Spam"),
      shelf("Carrots", "Peas & carrots", "Tomatoes", "Mushy peas", "Potatoes", "Garden peas", "Sweetcorn", "Spaghetti", "Spag bol", "Beans"),
      shelf("Chocolate bars", "UHT milk", "Cranberry juice", "Orange juice", "Apple juice"),
      shelf("Fizzy 2L", "Volvic", "Tonic / soda", "Small water"),
    ],
  },
  {
    name: "Corner: hot drinks", kind: "shelving", tall: 7, w: 5,
    shelves: [
      shelf("Pasta pots", "Pot Noodle"),
      shelf("PG Tips", "Tetley", "Typhoo", "Gold Label tea"),
      shelf("Sugar", "Nescafe large", "Maxwell House", "Yorkshire Tea", "Hot choc"),
      shelf("Nescafe boxes (small)"),
      shelf("Large water"),
    ],
  },
  {
    name: "Sauces, eggs & puddings", kind: "shelving", tall: 7, w: 7,
    shelves: [
      shelf("Gravy granules", "Salt", "Sunflower oil", "Pepper / grinders", "Soy sauce", "Vinegar", "Sweet chilli", "BBQ sauce", "Ketchup", "Salad cream", "Daddies", "Mayo"),
      shelf("Dumpling mix", "Stuffing mix", "Basmati rice", "Red cabbage", "Pickles", "Beetroot", "Apple sauce", "Mustard", "Mint sauce", "Branston", "Piccalilli", "Peanut butter"),
      shelf("Bananas", "Eggs"),
      shelf("Jam", "Marmalade", "Honey", "Carnation milk", "Pear halves", "Fruit cocktail", "Tinned fruit", "Prunes", "Pineapple pieces"),
      shelf("Jelly", "Custard (tin)", "Custard pots", "Rice pudding (tin)", "Rice pots", "Fruit pots", "Crackers"),
    ],
  },
  {
    name: "Cereals & paper", kind: "shelving", tall: 7, w: 6,
    shelves: [
      shelf("Shreddies", "Rice Snaps", "Cornflakes"),
      shelf("Crunchy Nut", "Crispy Minis", "Ready Brek", "Coco Pops"),
      shelf("Bran Flakes", "Weetabix"),
      shelf("Porridge pots", "Porridge sachets", "Oats"),
      shelf("Toilet rolls", "Kitchen rolls", "Swing bin", "Black bin bags"),
    ],
  },
  {
    name: "Household & toiletries", kind: "shelving", tall: 8, w: 6,
    shelves: [
      shelf("Persil", "Bold", "Fairy"),
      shelf("Tissues", "Toilet wipes", "Baby wipes", "Paracetamol", "Ibuprofen"),
      shelf("Vitamins & protein", "Batteries", "Soap", "Steradent", "Fixadent", "Toothpaste", "Toothbrush"),
      shelf("Handwash", "Shower gel", "Shampoo", "Conditioner", "Deodorant", "Razors"),
      shelf("Air freshener spray", "Bleach", "Easy spray", "Limescale", "Cream cleaner", "Polish"),
      shelf("Cling film", "Tin foil", "Freezer bags", "Fairy (small)", "Wipes", "Dishcloths", "Dustpan & brush"),
    ],
  },
  {
    name: "Freezer", kind: "freezer", tall: 8, w: 4,
    shelves: [
      shelf("Ice cream", "Jacket potatoes"),
      shelf("Korma", "Beef hotpot", "Lasagne", "Chilli con carne"),
      shelf("Beef dinner", "Stew & dumplings"),
      shelf("All day breakfast", "Fish & chips"),
      shelf("Grillsteak & mash", "Chicken & potatoes", "Pulled pork", "Tagliatelle", "Carbonara", "Bangers & mash"),
      shelf("Tikka masala", "Jalfrezi", "Stonebaked pizza"),
      shelf("Chips", "Frozen veg"),
    ],
  },
  {
    name: "Drinks fridge", kind: "fridge", tall: 7, w: 4,
    shelves: [
      shelf("Cans"),
      shelf("Fresh cream cakes"),
      shelf("Muffins & scones"),
      shelf("Cans (Dr Pepper / Irn-Bru)"),
      shelf("Bottled drinks & water"),
    ],
  },
  {
    name: "Fridge 2 (dairy)", kind: "fridge", tall: 7, w: 4,
    shelves: [
      shelf("Milk"),
      shelf("Yogurt"),
      shelf("Cooked meats"),
      shelf("Butter & spreads"),
      shelf("Cheese"),
    ],
  },
];

// Laid out in two rows so the plan order (top to bottom, left to right) is the
// walking order above. Drag the units on the Floor plan tab to match the real
// room; the walk re-orders itself to follow.
let x = 0, y = 0, rowHeight = 3;
const fixtures = bays.map((bay, index) => {
  if (index === 5) { x = 0; y = 5; }
  const fixture = {
    id: randomUUID(),
    name: bay.name,
    kind: bay.kind,
    x, y, w: bay.w, h: rowHeight,
    tall: bay.tall,
    grain: "rows",
    columns: bay.shelves,
  };
  x += bay.w;
  return fixture;
});

const layout = { cols: 40, rows: 10, fixtures };

if (process.argv.includes("--print")) {
  fixtures.forEach((f) => {
    console.log(`${f.name} (${f.kind}) - ${f.columns.length} shelves, ${f.columns.reduce((n, c) => n + c.sections.length, 0)} sections`);
  });
  process.exit(0);
}

const file = join(process.cwd(), ".local", "store-state.json");
const state = JSON.parse(readFileSync(file, "utf8"));
state.shop_layout = layout;
writeFileSync(file, JSON.stringify(state, null, 2));
const sections = fixtures.reduce((n, f) => n + f.columns.reduce((m, c) => m + c.sections.length, 0), 0);
console.log(`Wrote ${fixtures.length} bays and ${sections} named sections to ${file}`);
