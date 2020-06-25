function giveMutateRate(chance){
    let number = random(0, 1);
    if(number <= chance){
        return random(-1, 1);
    }
    return 0;
}

function setPopulation(){
    let fittest = getFittestBird();
    birds = [];
    for (let i = 0; i < POPULATION_SIZE; i++) {
        new Bird(100, 200, fittest.brain || null);
    }
}

function getFittestBird(){
    birds.sort(function(a, b){
        return a.fitness - b.fitness;
    });
    console.log(birds);
    return birds[0];
}