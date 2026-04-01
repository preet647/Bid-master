const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../data/players.json');

// Fetch all categories
const getCategories = () => {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data).categories;
};

// Fetch players by category
const getPlayersByCategory = (category) => {
    const categories = getCategories();
    const foundCategory = categories.find(cat => cat.category === category);
    return foundCategory ? foundCategory.players : [];
};

module.exports = { getCategories, getPlayersByCategory };
