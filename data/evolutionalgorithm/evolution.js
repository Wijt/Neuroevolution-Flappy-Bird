function giveMutateRate(chance){
    let number = random(0, 1);
    if(number <= chance){
        return random(-1, 1);
    }
    return 0;
}