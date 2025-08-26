module.exports = (sequelize, DataTypes) => {
    const Product = sequelize.define('Product', {
      title: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      price: {
        // Valor em centavos (por exemplo, 100 para R$1,00)
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      image: {
        // Utilize TEXT para imagens longas (ex: base64)
        type: DataTypes.TEXT,
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      orderIndex: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      }
    });
    return Product;
};
