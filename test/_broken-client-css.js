const CSS = `.a{color:red} /* 注释里有个反引号 ` 会把模板串提前终结 */ .b{};
console.log(CSS);
